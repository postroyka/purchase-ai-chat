<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Shef\Options\TraitList;
use Shef\Purchase\Config;

/**
 * Создание сделки закупки для procure-ai.
 * REST: shef:purchase.api.procuredeal.create
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

	// Защита от перегрузки: разумный потолок числа позиций в одной сделке.
	const MAX_ITEMS = 500;

	// Санитизация имени вложения (#103). Белый список расширений = то же множество, что
	// принимают фронт/бэк (ALLOWED_EXTENSIONS); неизвестное расширение → `.bin`.
	const ALLOWED_FILE_EXT = ['pdf', 'xlsx', 'docx', 'xls', 'jpg', 'jpeg', 'png'];
	const MAX_FILE_NAME_LEN = 200;

	protected static function getModulesList(): array
	{
		return ['crm', 'rest'];
	}

	public function configureActions(): array
	{
		return [
			'create' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * Привести недоверенное имя файла к безопасному виду перед сохранением вложения (#103):
	 *  - только базовое имя (срез пути `../`, `/etc/...`, `C:\...`);
	 *  - удаление ASCII control-символов (вкл. \0 и перевод строки) — анти log/header-injection;
	 *  - расширение из белого списка, иначе `.bin` (нейтрализация исполняемых/HTML-имён);
	 *  - ограничение длины с сохранением расширения; схлопнувшееся в пустоту имя → `document`.
	 * Вызывается только для непустого имени (см. createAction).
	 *
	 * @param string $name Сырое имя файла из документа/REST-вызова
	 * @return string Безопасное имя вида `<base>.<ext>`
	 */
	protected static function sanitizeFileName(string $name): string
	{
		// Нормализуем юникод-«слэши» (U+2215 ∕, U+FF0F ／) в обычный «/», чтобы basename
		// отрезал и «путь», собранный из них (basename понимает только ASCII-разделители).
		$name = str_replace(["\u{2215}", "\u{FF0F}", '\\'], '/', $name);
		// basename — только базовое имя (срез пути).
		$name = basename($name);
		// Срез ASCII control-символов и DEL.
		$name = preg_replace('/[\x00-\x1f\x7f]/', '', $name) ?? '';
		$name = trim($name);
		if($name === '' || $name === '.' || $name === '..')
		{
			$name = 'document.bin';
		}

		$dotPos = strrpos($name, '.');
		$base   = $dotPos === false ? $name : substr($name, 0, $dotPos);
		$ext    = $dotPos === false ? '' : strtolower(substr($name, $dotPos + 1));
		if($base === '')
		{
			$base = 'document'; // имя вида ".htaccess" — нет базовой части
		}
		if(!in_array($ext, static::ALLOWED_FILE_EXT, true))
		{
			$ext = 'bin';
		}

		// Ограничение длины базовой части (оставляем место под «.<ext>»). mb_*, чтобы не
		// разрезать многобайтовый UTF-8 посередине (длинные кириллические имена → битый UTF-8).
		$maxBase = max(1, static::MAX_FILE_NAME_LEN - strlen($ext) - 1);
		if(mb_strlen($base, 'UTF-8') > $maxBase)
		{
			$base = mb_substr($base, 0, $maxBase, 'UTF-8');
		}

		return $base.'.'.$ext;
	}

	/**
	 * @param int    $supplierId        ID компании-поставщика
	 * @param int    $responsibleUserId ID ответственного (b_user)
	 * @param string $fileName          Оригинальное имя файла
	 * @param string $fileContent       Содержимое файла в base64
	 * @param string $processingLog     Лог обработки (пишется в COMMENTS и таймлайн)
	 * @param array  $items             Позиции: [{ productId?, vendorCode?, name, priceExclVat, quantity }]
	 * @param int    $contractId        ID договора (0 = не найден) → UF_CRM_DEAL_DOGOVOR
	 * @param string $documentDate      Дата документа (счёта) в формате d.m.Y →
	 *                                   BEGINDATE на 09:00. Пусто → текущие дата-время.
	 * @return array|null { dealId, warnings?: string[] } | null при ошибке создания.
	 *   Возможные warnings: product_rows_failed | file_attach_failed |
	 *   invalid_base64_file | document_date_unparsed | timeline_comment_failed.
	 */
	public function createAction(
		int $supplierId,
		int $responsibleUserId,
		string $fileName,
		string $fileContent,
		string $processingLog,
		array $items,
		int $contractId = 0,
		string $documentDate = ''
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

		// Лимит на размер base64-содержимого файла: защита от прямых REST-вызовов в
		// обход MCP-слоя, который тоже ограничивает размер (NUXT_MAX_ATTACH_MB=25).
		// ~34 МБ base64 ≈ ~25 МБ бинарных данных.
		if($fileContent !== '' && strlen($fileContent) > 34 * 1024 * 1024)
		{
			$this->addError(new Error('fileContent too large', 'deal:022'));
			return null;
		}

		// Санитизация недоверенного имени файла (#103): fileName приходит из документа и
		// уходит в title и CRestUtil::saveFile. Контроллер вызывается и напрямую по REST в
		// обход basename MCP-слоя, поэтому здесь — единственная гарантированная защита от
		// path-traversal, control-символов (log/header-injection) и нежелательных расширений.
		// Пустое имя оставляем как есть — ниже есть отдельная ветка title («поставщик #N»).
		if($fileName !== '')
		{
			$fileName = static::sanitizeFileName($fileName);
		}

		$categoryId  = Config::getDealCategoryId();
		$stageId     = Config::getDealDefaultStageId();
		$measureCode = Config::getUnitOkeiSht();

		// --- 1) Создать сделку ---
		$titleBase = $fileName !== '' ? pathinfo($fileName, PATHINFO_FILENAME) : 'поставщик #'.$supplierId;
		// BEGINDATE («Дата начала») — обязательное поле воронки «Закупки».
		// Если передана дата документа (счёта) — ставим её на 09:00 (считаем, что
		// документ оформлен утром); иначе — текущие дата-время.
		$beginTs = null;
		$documentDateUnparsed = false;
		if($documentDate !== '')
		{
			// Дата документа приходит строго в формате d.m.Y (контракт MCP).
			// Разбираем явно + checkdate: MakeTimeStamp принимал бы и календарно
			// невалидные значения (mktime(99,99,…) переполняется в будущее), что
			// дало бы абсурдную BEGINDATE без предупреждения (#113).
			if(preg_match('/^(\d{2})\.(\d{2})\.(\d{4})$/', $documentDate, $m)
				&& checkdate((int)$m[2], (int)$m[1], (int)$m[3]))
			{
				$beginTs = mktime(9, 0, 0, (int)$m[2], (int)$m[1], (int)$m[3]);
			}
			else
			{
				// documentDate передан, но не d.m.Y / не календарная дата →
				// подставим now(), но просигналим в warnings (#102).
				$documentDateUnparsed = true;
			}
		}
		if($beginTs === null)
		{
			$beginTs = time();
		}

		$dealFields = [
			'TITLE'          => 'Закупка: '.$titleBase,
			'COMPANY_ID'     => $supplierId,
			'ASSIGNED_BY_ID' => $responsibleUserId,
			'CATEGORY_ID'    => $categoryId,
			'STAGE_ID'       => $stageId,
			'CURRENCY_ID'    => 'BYN',
			'COMMENTS'       => $processingLog,
			'BEGINDATE'      => \ConvertTimeStamp($beginTs, 'FULL'),
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
		if($documentDateUnparsed)
		{
			$warnings[] = 'document_date_unparsed';
		}

		// --- 2) Товарные позиции (TAX_RATE=20, TAX_INCLUDED=Y — бизнес-решение) ---
		$productRows = [];
		foreach($items as $item)
		{
			// Серверная страховка (Zod на стороне MCP уже это проверяет, но прямой
			// REST-вызов мог бы обойти):
			// - цена неотрицательная, КОНЕЧНАЯ и округлена до 2 знаков (#101) — иначе
			//   float-погрешность OCR/LLM (напр. 12.991) уедет в PRICE и сумма сделки
			//   разойдётся с бумажным счётом. Округление есть и на MCP-границе —
			//   намеренное дублирование: контроллер прикрывает прямой REST в обход MCP.
			// - количество — целое число (правило 4 промпта, единица всегда «шт»);
			//   держим как float — Bitrix ждёт double в QUANTITY, значение всегда целое.
			$price = round(max(0.0, (float)($item['priceExclVat'] ?? 0)), 2);
			if(!is_finite($price))
			{
				$price = 0.0; // астрономический/Infinity-вход → 0, а не мусор в сделке
			}
			$quantity = round((float)($item['quantity'] ?? 1));
			if($quantity <= 0)
			{
				$quantity = 1.0;
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
				// CCrmDeal::Update() принимает $arFields ПО ССЫЛКЕ (array &$arFields) —
				// нельзя передать литерал массива, только переменную (иначе фатальная
				// ошибка «Cannot pass parameter 2 by reference»).
				$fileFields = ['UF_CRM_DEAL_SH_PRCHS_AI_FILE' => $fileArray];
				if(!$deal->Update($dealId, $fileFields))
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
		// Таймлайн — некритичная часть: сделка уже создана. Любой сбой не должен
		// валить весь вызов (агент обязан получить dealId) — фиксируем как warning.
		if($processingLog !== '')
		{
			try
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
					// onCreate() принимает 2-й параметр ПО ССЫЛКЕ — нельзя передать
					// литерал массива, только переменную (иначе фатальная ошибка
					// «Cannot pass parameter 2 by reference»).
					$onCreateFields = [
						'COMMENT'        => $processingLog,
						'ENTITY_TYPE_ID' => \CCrmOwnerType::Deal,
						'ENTITY_ID'      => $dealId,
						'AUTHOR_ID'      => $responsibleUserId,
					];
					\Bitrix\Crm\Timeline\CommentController::getInstance()->onCreate($commentId, $onCreateFields);
				}
			}
			catch(\Throwable $e)
			{
				$warnings[] = 'timeline_comment_failed';
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
