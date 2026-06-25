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
 *   TITLE       = «Импорт прайса от <название компании-поставщика>»; если поставщик не найден —
 *                 «Импорт прайса — поставщик не найден (УНП …)», сделка без COMPANY_ID
 *   Каждая позиция: TAX_RATE=20, TAX_INCLUDED=Y, единица=шт, цена = priceExclVat
 *   Позиция с артикулом, не сопоставленным с каталогом, в сделку не кладётся.
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
		// Транслит кириллицы → латиница: Б24 (CFile) при сохранении вложения выкидывает
		// не-ASCII из имени («Профтейп-byn.pdf» → «-byn.pdf»). Приводим к ASCII заранее,
		// чтобы имя осталось осмысленным («Profteyp-byn.pdf»).
		$base = static::translitToAscii($base);
		if($base === '')
		{
			$base = 'document'; // нет базовой части (или после транслита/санитизации пусто)
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
	 * Транслитерация кириллицы (рус/бел) в латиницу + срез остатка не-ASCII. Нужна потому,
	 * что Б24 при сохранении файла-вложения (CFile) выбрасывает не-ASCII из имени, и
	 * кириллическое «Профтейп.pdf» превращается в огрызок «.pdf». Приводим к ASCII сами,
	 * сохраняя осмысленность («Profteyp»).
	 */
	protected static function translitToAscii(string $s): string
	{
		static $map = [
			'а'=>'a','б'=>'b','в'=>'v','г'=>'g','д'=>'d','е'=>'e','ё'=>'e','ж'=>'zh','з'=>'z',
			'и'=>'i','й'=>'y','к'=>'k','л'=>'l','м'=>'m','н'=>'n','о'=>'o','п'=>'p','р'=>'r',
			'с'=>'s','т'=>'t','у'=>'u','ф'=>'f','х'=>'h','ц'=>'ts','ч'=>'ch','ш'=>'sh','щ'=>'sch',
			'ъ'=>'','ы'=>'y','ь'=>'','э'=>'e','ю'=>'yu','я'=>'ya','і'=>'i','ў'=>'u',
			'А'=>'A','Б'=>'B','В'=>'V','Г'=>'G','Д'=>'D','Е'=>'E','Ё'=>'E','Ж'=>'Zh','З'=>'Z',
			'И'=>'I','Й'=>'Y','К'=>'K','Л'=>'L','М'=>'M','Н'=>'N','О'=>'O','П'=>'P','Р'=>'R',
			'С'=>'S','Т'=>'T','У'=>'U','Ф'=>'F','Х'=>'H','Ц'=>'Ts','Ч'=>'Ch','Ш'=>'Sh','Щ'=>'Sch',
			'Ъ'=>'','Ы'=>'Y','Ь'=>'','Э'=>'E','Ю'=>'Yu','Я'=>'Ya','І'=>'I','Ў'=>'U',
		];
		$s = strtr($s, $map);
		// Остаток вне печатного ASCII убираем — Б24 всё равно бы выкинул.
		return trim(preg_replace('/[^\x20-\x7e]/', '', $s) ?? $s);
	}

	/**
	 * Название компании-поставщика для заголовка сделки («Импорт прайса от <название>»).
	 * Тянем TITLE из CRM по ID одним точечным запросом; пусто/не найдено → фолбэк
	 * «поставщик #N». Имя файла в заголовок больше не идёт (только во вложение).
	 *
	 * @param int $supplierId ID компании-поставщика (COMPANY_ID сделки)
	 * @return string Название компании либо «поставщик #N»
	 */
	protected static function fetchSupplierName(int $supplierId): string
	{
		$res = \CCrmCompany::GetListEx(
			[],
			['=ID' => $supplierId, 'CHECK_PERMISSIONS' => 'N'],
			false,
			false,
			['ID', 'TITLE']
		);
		$row   = is_object($res) ? $res->Fetch() : false;
		$title = is_array($row) ? trim((string)($row['TITLE'] ?? '')) : '';

		return $title !== '' ? $title : 'поставщик #'.$supplierId;
	}

	/**
	 * @param int    $supplierId        ID компании-поставщика (0 = не найден → сделка без COMPANY_ID,
	 *                                  warning supplier_not_found, УНП в заголовок)
	 * @param int    $responsibleUserId ID ответственного (b_user)
	 * @param string $fileName          Оригинальное имя файла
	 * @param string $fileContent       Содержимое файла в base64
	 * @param string $processingLog     Лог обработки (пишется в COMMENTS и таймлайн)
	 * @param array  $items             Позиции: [{ productId?, vendorCode?, name, priceExclVat, quantity }].
	 *                                  В сделку кладутся ТОЛЬКО позиции с сопоставленным товаром
	 *                                  (productId непустой). Без productId — артикул не найден ИЛИ
	 *                                  артикула нет вовсе — позиция НЕ кладётся (#258: свободные
	 *                                  строки PRODUCT_ID=0 больше не создаём; см. prompts/main.md, Шаг 4).
	 * @param int    $contractId        ID договора (0 = не найден) → UF_CRM_DEAL_DOGOVOR
	 * @param string $documentDate      Дата документа (счёта) в формате d.m.Y →
	 *                                   BEGINDATE на 09:00. Пусто → текущие дата-время.
	 * @param string $supplierUnp       УНП/ИНН поставщика из документа — в заголовок, КОГДА компания
	 *                                  не найдена (supplierId=0). Недоверенный: в title только цифры.
	 * @return array|null { dealId, warnings?: string[] } | null при ошибке создания.
	 *   Возможные warnings: supplier_not_found | no_items_matched | product_rows_failed |
	 *   file_attach_failed | invalid_base64_file | document_date_unparsed | timeline_comment_failed.
	 */
	public function createAction(
		int $supplierId,
		int $responsibleUserId,
		string $fileName,
		string $fileContent,
		string $processingLog,
		array $items,
		int $contractId = 0,
		string $documentDate = '',
		string $supplierUnp = ''
	): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		// supplierId может быть 0 — поставщик по УНП не найден (#supplier-not-found): сделку всё равно
		// создаём, но БЕЗ COMPANY_ID, с УНП в заголовке и warning supplier_not_found. Обязателен только
		// ответственный (сделку нужно на кого-то назначить).
		if($responsibleUserId < 1)
		{
			$this->addError(new Error('Invalid responsibleUserId', 'deal:010'));
			return null;
		}
		$hasSupplier = $supplierId >= 1;

		// Пустой items[] больше НЕ ошибка: если все позиции имели артикул, но ни одна не
		// сопоставлена с каталогом (см. prompts/main.md, Шаг 4), сделку всё равно создаём
		// (поставщик/договор валидны), позиции — в processingLog, + warning no_items_matched.
		// Прежний гард deal:020 снят осознанно (согласовано).
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
		// Заголовок — «Импорт прайса от <поставщик>» (имя из CRM по COMPANY_ID). Если поставщик не
		// найден — «Импорт прайса — поставщик не найден (УНП …)»: УНП недоверенный (из документа),
		// поэтому в заголовок берём только цифры/латиницу и обрезаем. Имя файла в заголовок не идёт.
		if($hasSupplier)
		{
			$titleRaw = 'Импорт прайса от '.static::fetchSupplierName($supplierId);
		}
		else
		{
			$unp = substr(preg_replace('/\D/', '', $supplierUnp) ?? '', 0, 20); // УНП/ИНН — только цифры
			$titleRaw = 'Импорт прайса — поставщик не найден'.($unp !== '' ? ' (УНП '.$unp.')' : '');
		}
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

		// TITLE сделки — varchar(255) в Б24: длинное название компании обрезаем, иначе БД
		// усечёт молча (или уронит вставку в strict-режиме → сделка не создастся).
		$title = mb_substr($titleRaw, 0, 255, 'UTF-8');

		$dealFields = [
			'TITLE'          => $title,
			'ASSIGNED_BY_ID' => $responsibleUserId,
			'CATEGORY_ID'    => $categoryId,
			'STAGE_ID'       => $stageId,
			'CURRENCY_ID'    => 'BYN',
			'COMMENTS'       => $processingLog,
			'BEGINDATE'      => \ConvertTimeStamp($beginTs, 'FULL'),
		];
		// COMPANY_ID — только если поставщик найден; иначе сделка без компании (привязка вручную).
		if($hasSupplier)
		{
			$dealFields['COMPANY_ID'] = $supplierId;
		}

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
		if(!$hasSupplier)
		{
			$warnings[] = 'supplier_not_found';
		}
		if($documentDateUnparsed)
		{
			$warnings[] = 'document_date_unparsed';
		}

		// --- 2) Товарные позиции (TAX_RATE=20, TAX_INCLUDED=Y — бизнес-решение) ---
		// #301: наименование строки товара — server-authoritative из каталога Битрикса по productId,
		// а НЕ из документа поставщика (присланный name используем лишь как фолбэк). Один батч-запрос
		// имён по всем productId (без N+1, #148). Дублирует правило промпта #270 на уровне контроллера.
		$catalogNames = self::fetchCatalogNames($items);
		$productRows = [];
		foreach($items as $item)
		{
			// В сделку кладём ТОЛЬКО позиции, сопоставленные с каталогом (есть productId).
			// Без productId — артикул не найден в каталоге ИЛИ артикула нет вовсе — позицию
			// НЕ кладём (#258: свободные строки PRODUCT_ID=0 больше не создаём). Дублирует
			// правило промпта на уровне контроллера, т.к. модель не всегда исключает такие
			// позиции сама. empty() ловит пустую строку, '0', null и отсутствие — productId
			// всегда положительный id товара, поэтому «0»/пусто = «не сопоставлено».
			if(empty($item['productId']))
			{
				continue;
			}

			// Серверная страховка (Zod на стороне MCP уже это проверяет, но прямой
			// REST-вызов мог бы обойти):
			// - цена неотрицательная, КОНЕЧНАЯ и округлена до 2 знаков (#101) — иначе
			//   float-погрешность OCR/LLM (напр. 12.991) уедет в PRICE и сумма сделки
			//   разойдётся с бумажным счётом. Округление есть и на MCP-границе —
			//   намеренное дублирование: контроллер прикрывает прямой REST в обход MCP.
			// - количество (#286) — может быть дробным (224.8 м/кг/м³), округляем до 2 знаков
			//   (как цену); Bitrix QUANTITY принимает double. До #286 округляли до целого.
			$price = round(max(0.0, (float)($item['priceExclVat'] ?? 0)), 2);
			if(!is_finite($price))
			{
				$price = 0.0; // астрономический/Infinity-вход → 0, а не мусор в сделке
			}
			$quantity = round((float)($item['quantity'] ?? 1), 2);
			// is_finite — та же страховка, что и у цены: на прямом REST в обход MCP
			// (Infinity/NaN/1e308) round() не финитизирует, а `<= 0` не ловит NaN/+INF →
			// мусор в QUANTITY и битый total сделки. Не-финит/≤0 → 1.0.
			if(!is_finite($quantity) || $quantity <= 0)
			{
				$quantity = 1.0;
			}

			// #301: каноническое имя из каталога по productId; фолбэк на присланное имя, если товар
			// не нашёлся (рассинхрон/неактивен) или у него пустое имя.
			$pid = (int)$item['productId'];
			$productName = $catalogNames[$pid] ?? '';
			if($productName === '')
			{
				$productName = (string)($item['name'] ?? '');
			}
			$productRows[] = [
				'PRODUCT_ID'   => $pid, // всегда задан: позиции без productId отсеяны выше (#258)
				'PRODUCT_NAME' => $productName,
				'PRICE'        => $price,
				'QUANTITY'     => $quantity,
				'TAX_RATE'     => 20,
				'TAX_INCLUDED' => 'Y',
				'MEASURE_CODE' => $measureCode,
				'MEASURE_NAME' => 'шт',
			];
		}
		if(empty($productRows))
		{
			// Ни одна позиция не сопоставлена с каталогом: сделку создали, позиций нет.
			// SaveProductRows с пустым массивом не зовём — просто сигналим оператору.
			$warnings[] = 'no_items_matched';
		}
		elseif(!\CCrmDeal::SaveProductRows($dealId, $productRows))
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

	/**
	 * #301: каноническое наименование товара из каталога по productId.
	 *
	 * Собирает уникальные положительные productId из позиций и ОДНИМ запросом (`CIBlockElement::GetList`
	 * с фильтром ID IN [...]) тянет их NAME — server-authoritative имя строки сделки, не зависящее от
	 * того, что прислал агент/прямой REST. Без N+1 (один round-trip, #148). Позиции без productId
	 * (несопоставленные) сюда не попадают — они и так не кладутся в сделку (#258).
	 *
	 * @param array $items позиции запроса (каждая может содержать productId)
	 * @return array<int,string> карта productId → NAME (только для найденных в каталоге)
	 */
	private static function fetchCatalogNames(array $items): array
	{
		$ids = [];
		foreach($items as $item)
		{
			$pid = (int)($item['productId'] ?? 0);
			if($pid > 0)
			{
				$ids[$pid] = true; // dedup по id
			}
		}
		if(empty($ids))
		{
			return [];
		}

		$names = [];
		$res = \CIBlockElement::GetList(
			['ID' => 'ASC'],
			['ID' => array_keys($ids), 'IBLOCK_ID' => Config::getCatalogIblockId()],
			false,
			false,
			['ID', 'NAME']
		);
		if(is_object($res))
		{
			while($row = $res->Fetch())
			{
				$names[(int)$row['ID']] = (string)$row['NAME'];
			}
		}
		return $names;
	}
}
