<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Bitrix\Main\Config\Option;
use Shef\Options\TraitList;

/**
 * Создание сделки закупки для procure-ai.
 * REST: shef.purchase.api.procuredeal.create
 *
 * Бизнес-правила (бриф, не менять без согласования):
 *   CATEGORY_ID = 1 («Закупки»)
 *   STAGE_ID    = C1:NEW
 *   CURRENCY_ID = BYN
 *   Каждая позиция: TAX_RATE=20, TAX_INCLUDED=Y, единица=шт, цена = priceExclVat
 *   Сделка создаётся всегда (дублей не проверяем).
 *   fileContent (base64) → UF_CRM_DEAL_SH_PRCHS_AI_FILE + таймлайн-комментарий.
 *   processingLog → COMMENTS сделки + CommentEntry в таймлайне.
 *   contractId → UF_CRM_DEAL_DOGOVOR (привязка договора).
 */
class ProcureDeal
	extends Engine\Controller
{
	use TraitList\Modules;

	// ОКЕИ-код «штука». В CCrmDeal::SaveProductRows MEASURE_CODE — это код ОКЕИ
	// (796 = штука), не ID записи b_catalog_measure. Переопределяется опцией
	// модуля на случай нестандартной настройки каталога.
	const UNIT_OKEI_SHT = 796;

	// Защита от перегрузки: разумный потолок числа позиций в одной сделке.
	const MAX_ITEMS = 500;

	protected static function getModulesList(): array
	{
		return ['crm', 'rest'];
	}

	public function configureActions()
	{
		return [
			'create' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * @param int    $supplierId        ID компании-поставщика
	 * @param int    $responsibleUserId ID ответственного (b_user)
	 * @param string $fileName          Оригинальное имя файла
	 * @param string $fileContent       Содержимое файла в base64
	 * @param string $processingLog     Лог обработки (пишется в COMMENTS и таймлайн)
	 * @param array  $items             Позиции: [{ productId?, vendorCode?, name, priceExclVat, quantity }]
	 * @param int    $contractId        ID договора (0 = не найден) → UF_CRM_DEAL_DOGOVOR
	 * @return array|null { dealId, warnings?: string[] } | null при ошибке создания
	 */
	public function createAction(
		int $supplierId,
		int $responsibleUserId,
		string $fileName,
		string $fileContent,
		string $processingLog,
		array $items,
		int $contractId = 0
	): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		if($supplierId < 1 || $responsibleUserId < 1)
		{
			$this->addError(new Error('Invalid supplierId or responsibleUserId', 'deal:010'));
			return null;
		}

		if(empty($items))
		{
			$this->addError(new Error('items is empty', 'deal:020'));
			return null;
		}

		if(count($items) > static::MAX_ITEMS)
		{
			$this->addError(new Error('too many items (max '.static::MAX_ITEMS.')', 'deal:021'));
			return null;
		}

		$categoryId  = (int)Option::get('shef.purchase', 'B24_DEAL_CATEGORY_ID', 1);
		$stageId     = Option::get('shef.purchase', 'B24_DEAL_DEFAULT_STAGE_ID', 'C1:NEW');
		$measureCode = (int)Option::get('shef.purchase', 'B24_UNIT_OKEI_SHT', static::UNIT_OKEI_SHT);

		// --- 1) Создать сделку ---
		$dealFields = [
			'TITLE'          => 'Закупка от поставщика #'.$supplierId,
			'COMPANY_ID'     => $supplierId,
			'ASSIGNED_BY_ID' => $responsibleUserId,
			'CATEGORY_ID'    => $categoryId,
			'STAGE_ID'       => $stageId,
			'CURRENCY_ID'    => 'BYN',
			'COMMENTS'       => $processingLog,
		];

		// Привязка договора к сделке (поле подтверждено заказчиком).
		if($contractId > 0)
		{
			$dealFields['UF_CRM_DEAL_DOGOVOR'] = $contractId;
		}

		$deal   = new \CCrmDeal(false);
		$dealId = $deal->Add($dealFields, true);

		if(!$dealId)
		{
			$err = $deal->LAST_ERROR ?: 'CCrmDeal::Add failed';
			$this->addError(new Error($err, 'deal:030'));
			return null;
		}

		$dealId = (int)$dealId;
		// Некритичные проблемы после создания сделки: не валят вызов (агент должен
		// получить dealId), но возвращаются в payload, чтобы попасть в отчёт.
		$warnings = [];

		// --- 2) Товарные позиции (TAX_RATE=20, TAX_INCLUDED=Y — бизнес-решение) ---
		$productRows = [];
		foreach($items as $item)
		{
			// Серверная страховка: цена/кол-во не отрицательные (Zod на стороне
			// MCP уже это проверяет, но прямой REST-вызов мог бы обойти).
			$price    = max(0.0, (float)($item['priceExclVat'] ?? 0));
			$quantity = (float)($item['quantity'] ?? 1);
			if($quantity <= 0)
			{
				$quantity = 1;
			}

			$productRows[] = [
				'PRODUCT_ID'   => isset($item['productId']) ? (int)$item['productId'] : 0,
				'PRODUCT_NAME' => (string)($item['name'] ?? ''),
				'PRICE'        => $price,
				'QUANTITY'     => $quantity,
				'TAX_RATE'     => 20,
				'TAX_INCLUDED' => 'Y',
				'MEASURE_CODE' => $measureCode,
				'MEASURE_NAME' => 'шт',
			];
		}
		if(!\CCrmDeal::SaveProductRows($dealId, $productRows))
		{
			// Сделка уже создана; позиции не сохранились — сигналим в warnings, но
			// сделку не откатываем (агент увидит и сможет дозаполнить вручную).
			$warnings[] = 'product_rows_failed';
		}

		// --- 3) Прикрепить файл к UF-полю сделки (B6) ---
		if($fileContent !== '')
		{
			$fileArray = \CRestUtil::saveFile([$fileName, $fileContent]);
			if(is_array($fileArray))
			{
				if(!$deal->Update($dealId, ['UF_CRM_DEAL_SH_PRCHS_AI_FILE' => $fileArray]))
				{
					// Файл — не критичная часть сделки: фиксируем как warning.
					$warnings[] = 'file_attach_failed';
				}
			}
			else
			{
				$warnings[] = 'invalid_base64_file';
			}
		}

		// --- 4) Запись в таймлайн сделки (B7) ---
		if($processingLog !== '')
		{
			$commentId = \Bitrix\Crm\Timeline\CommentEntry::create([
				'AUTHOR_ID' => $responsibleUserId,
				'TEXT'      => $processingLog,
				'SETTINGS'  => [],
				'BINDINGS'  => [[
					'ENTITY_TYPE_ID' => \CCrmOwnerType::Deal,
					'ENTITY_ID'      => $dealId,
					'IS_FIXED'       => true,
				]],
			]);

			if($commentId > 0)
			{
				\Bitrix\Crm\Timeline\CommentController::getInstance()->onCreate($commentId, [
					'COMMENT'        => $processingLog,
					'ENTITY_TYPE_ID' => \CCrmOwnerType::Deal,
					'ENTITY_ID'      => $dealId,
					'AUTHOR_ID'      => $responsibleUserId,
				]);
			}
		}

		$result = ['dealId' => $dealId];
		if(!empty($warnings))
		{
			$result['warnings'] = $warnings;
		}
		return $result;
	}
}
