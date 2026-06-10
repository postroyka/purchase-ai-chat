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
 */
class ProcureDeal
	extends Engine\Controller
{
	use TraitList\Modules;

	const UNIT_ID_SHT = 796; // ОКЕИ: штука

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
	 * @param int    $contractId        ID договора (0 = не найден)
	 * @return array|null { dealId } | null при ошибке
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

		$categoryId = (int)Option::get('shef.purchase', 'B24_DEAL_CATEGORY_ID', 1);
		$stageId    = Option::get('shef.purchase', 'B24_DEAL_DEFAULT_STAGE_ID', 'C1:NEW');

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

		$deal   = new \CCrmDeal(false);
		$dealId = $deal->Add($dealFields, true);

		if(!$dealId)
		{
			$err = $deal->LAST_ERROR ?: 'CCrmDeal::Add failed';
			$this->addError(new Error($err, 'deal:030'));
			return null;
		}

		$dealId = (int)$dealId;

		// --- 2) Товарные позиции (TAX_RATE=20, TAX_INCLUDED=Y — бизнес-решение) ---
		$productRows = [];
		foreach($items as $item)
		{
			$productRows[] = [
				'PRODUCT_ID'   => isset($item['productId']) ? (int)$item['productId'] : 0,
				'PRODUCT_NAME' => (string)($item['name'] ?? ''),
				'PRICE'        => (float)($item['priceExclVat'] ?? 0),
				'QUANTITY'     => (float)($item['quantity'] ?? 1),
				'TAX_RATE'     => 20,
				'TAX_INCLUDED' => 'Y',
				'MEASURE_CODE' => static::UNIT_ID_SHT,
				'MEASURE_NAME' => 'шт',
			];
		}
		\CCrmDeal::SaveProductRows($dealId, $productRows);

		// --- 3) Прикрепить файл к UF-полю сделки (B6) ---
		if($fileContent !== '')
		{
			$fileArray = \CRestUtil::saveFile([$fileName, $fileContent]);
			if(is_array($fileArray))
			{
				$deal->Update($dealId, [
					'UF_CRM_DEAL_SH_PRCHS_AI_FILE' => $fileArray,
				]);
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

		return ['dealId' => $dealId];
	}
}
