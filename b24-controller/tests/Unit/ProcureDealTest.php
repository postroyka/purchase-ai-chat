<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\Purchase\Controllers\ProcureDeal;
use Shef\Purchase\Tests\Stub;

/**
 * Создание сделки: guard-коды, бизнес-правила позиций, warnings, и две ключевые
 * регрессии — by-ref Update/onCreate (#99) и непарсибельная дата документа (#113).
 */
final class ProcureDealTest extends TestCase
{
	protected function setUp(): void
	{
		Stub::reset();
	}

	/** Минимальный валидный набор позиций. */
	private function items(): array
	{
		return [
			['name' => 'Болт', 'priceExclVat' => 100.0, 'quantity' => 2, 'vendorCode' => 'B1', 'productId' => '7'],
		];
	}

	public function testSupplierNotFoundCreatesDealWithoutCompany(): void
	{
		// #supplier-not-found: supplierId=0 больше НЕ ошибка — сделка создаётся БЕЗ COMPANY_ID,
		// УНП идёт в заголовок, warning supplier_not_found. Обработку не останавливаем.
		\CCrmDeal::$addReturn = 777;
		$c = new ProcureDeal();
		$res = $c->createAction(0, 2, 'f.pdf', '', 'log', $this->items(), 0, '', '192775574');

		$this->assertSame(777, $res['dealId']);
		$this->assertContains('supplier_not_found', $res['warnings']);
		// Компания НЕ привязана.
		$this->assertArrayNotHasKey('COMPANY_ID', \CCrmDeal::$lastAddFields);
		// УНП (только цифры) — в заголовке.
		$this->assertStringContainsString('192775574', \CCrmDeal::$lastAddFields['TITLE']);
		$this->assertStringContainsString('не найден', \CCrmDeal::$lastAddFields['TITLE']);
	}

	public function testSupplierUnpSanitizedInTitle(): void
	{
		// УНП недоверенный (из документа) — в заголовок только цифры, буквы/спецсимволы вырезаются.
		\CCrmDeal::$addReturn = 778;
		$c = new ProcureDeal();
		$c->createAction(0, 2, 'f.pdf', '', 'log', $this->items(), 0, '', "19<script>27\n55-74");
		$this->assertStringContainsString('192755', \CCrmDeal::$lastAddFields['TITLE']);
		$this->assertStringNotContainsString('<script>', \CCrmDeal::$lastAddFields['TITLE']);
	}

	public function testInvalidResponsibleUserIdReturnsDeal010(): void
	{
		// Правая ветка условия (responsibleUserId < 1) — отдельно, чтобы случайная
		// замена OR→AND в guard'е не осталась незамеченной.
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(1, 0, 'f.pdf', '', 'log', $this->items()));
		$this->assertSame(['deal:010'], $c->errorCodes());
	}

	public function testEmptyItemsCreatesDealWithNoItemsWarning(): void
	{
		// Пустой items[] больше НЕ ошибка (deal:020 снят): сделка создаётся, позиций нет →
		// warning no_items_matched. Поставщик/договор валидны, оператор заведёт позиции вручную.
		\CCrmDeal::$addReturn = 555;
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', []);
		$this->assertSame(555, $res['dealId']);
		$this->assertContains('no_items_matched', $res['warnings']);
		$this->assertNotContains('deal:020', $c->errorCodes());
	}

	public function testTooManyItemsReturnDeal021(): void
	{
		$items = array_fill(0, 501, ['name' => 'x', 'priceExclVat' => 1.0, 'quantity' => 1]);
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(1, 1, 'f.pdf', '', 'log', $items));
		$this->assertContains('deal:021', $c->errorCodes());
	}

	public function testOversizeFileContentReturnsDeal022(): void
	{
		$big = str_repeat('A', 34 * 1024 * 1024 + 1);
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(1, 1, 'f.pdf', $big, 'log', $this->items()));
		$this->assertContains('deal:022', $c->errorCodes());
	}

	public function testDealAddFailureReturnsDeal030(): void
	{
		\CCrmDeal::$addReturn = false;
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(1, 2, 'f.pdf', '', 'log', $this->items()));
		$this->assertContains('deal:030', $c->errorCodes());
	}

	public function testHappyPathReturnsDealIdWithoutWarnings(): void
	{
		\CCrmDeal::$addReturn = 321;
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'invoice.pdf', '', 'обработано', $this->items());

		$this->assertSame(321, $res['dealId']);
		$this->assertArrayNotHasKey('warnings', $res);

		// Бизнес-правила позиции: TAX_RATE=20, TAX_INCLUDED=Y (откат #326 на перепроверку), «шт», цена как есть.
		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(20, $row['TAX_RATE']);
		$this->assertSame('Y', $row['TAX_INCLUDED']);
		$this->assertSame('шт', $row['MEASURE_NAME']);
		$this->assertSame(100.0, $row['PRICE']);
		$this->assertSame(2.0, $row['QUANTITY']); // целое значение, тип float (Bitrix QUANTITY = double)
		$this->assertSame(7, $row['PRODUCT_ID']);

		// Базовые поля сделки.
		$this->assertSame('BYN', \CCrmDeal::$lastAddFields['CURRENCY_ID']);
		$this->assertSame(1, \CCrmDeal::$lastAddFields['COMPANY_ID']);
		$this->assertSame(2, \CCrmDeal::$lastAddFields['ASSIGNED_BY_ID']);
	}

	public function testProductNameComesFromCatalogNotDocument(): void
	{
		// #301: имя строки сделки — каноническое из каталога по productId, а не из документа.
		\CCrmDeal::$addReturn = 1;
		// каталог по ID=7 отдаёт «правильное» имя; в документе пришло «Болт» (см. items()).
		\CIBlockElement::$resultQueue = [[['ID' => 7, 'NAME' => 'Болт М8 ГОСТ 7798 (каталог)']]];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $this->items());
		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame('Болт М8 ГОСТ 7798 (каталог)', $row['PRODUCT_NAME']);
		$this->assertSame(7, $row['PRODUCT_ID']);
		// батч-запрос имён сделан по ID IN [7].
		$call = \CIBlockElement::$calls[0];
		$this->assertSame([7], $call['filter']['ID']);
	}

	public function testProductNameFallsBackToDocumentWhenNotInCatalog(): void
	{
		// #301: если товар не нашёлся в каталоге (рассинхрон/неактивен) — фолбэк на имя из документа.
		\CCrmDeal::$addReturn = 1;
		\CIBlockElement::$resultQueue = [[]]; // каталог ничего не вернул
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $this->items());
		$this->assertSame('Болт', \CCrmDeal::$lastProductRows[0]['PRODUCT_NAME']);
	}

	public function testNegativePriceAndQuantityAreClamped(): void
	{
		\CCrmDeal::$addReturn = 1;
		// productId задан (#258: позиции без productId не кладутся) — проверяем зажим цены/кол-ва.
		$items = [['name' => 'X', 'priceExclVat' => -5.0, 'quantity' => 0, 'productId' => '7']];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(0.0, $row['PRICE']);   // max(0.0, -5.0) → float 0.0
		// Кол-во <=0 → 1 (контроллер присваивает int-литерал; тип не важен — Bitrix
		// принимает оба, поэтому сверяем значение, а не тип).
		$this->assertEquals(1, $row['QUANTITY']);
	}

	public function testNonFiniteQuantityClampsToOne(): void
	{
		// #286: на прямом REST (в обход Zod) Infinity/NaN в quantity не должны утечь в
		// QUANTITY — is_finite-страховка зажимает их к 1.0 (иначе total сделки = INF/NaN).
		\CCrmDeal::$addReturn = 1;
		$items = [
			['name' => 'INF', 'priceExclVat' => 10.0, 'quantity' => INF, 'productId' => '7'],
			['name' => 'NaN', 'priceExclVat' => 10.0, 'quantity' => NAN, 'productId' => '8'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$this->assertSame(1.0, \CCrmDeal::$lastProductRows[0]['QUANTITY']);
		$this->assertSame(1.0, \CCrmDeal::$lastProductRows[1]['QUANTITY']);
	}

	public function testPriceRoundedToKopecksAndQuantityToTwoDecimals(): void
	{
		// Прямой REST в обход Zod: float-погрешность цены (>2 знаков) и дробное кол-во.
		// #101 — цена округляется до копеек; #286 — кол-во до 2 знаков (а не до целого:
		// 1.5 м/кг/м³ — допустимое значение), иначе сумма сделки разойдётся с бумажным счётом.
		$items = [
			['name' => 'Кабель', 'priceExclVat' => 12.991, 'quantity' => 1.5, 'productId' => '7'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(12.99, $row['PRICE']);  // round(12.991, 2)
		$this->assertSame(1.5, $row['QUANTITY']);  // #286 — дробное кол-во сохраняется
	}

	public function testPriceWrittenOneToOneWithTaxIncludedY(): void
	{
		// Откат #326: TAX_INCLUDED='Y' (перепроверка НДС-модели на боевом портале). PRICE
		// по-прежнему пишется 1-в-1 из priceExclVat (контроллер НЕ домножает на 1.2) — меняется
		// только флаг включённости НДС. Финальная модель — по итогам теста.
		$items = [
			['name' => 'Круг отрезной', 'priceExclVat' => 0.51, 'quantity' => 50, 'productId' => '7'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame('Y', $row['TAX_INCLUDED']); // откат #326
		$this->assertSame(0.51, $row['PRICE']);       // PRICE 1-в-1 из priceExclVat
		$this->assertSame(20, $row['TAX_RATE']);
	}

	public function testHalfKopeckRoundsHalfUpAndFractionalQuantityKeptToTwoDecimals(): void
	{
		// Краевые случаи прямого REST: PHP round() — HALF_UP (12.995 → 13.00, как
		// бумажный счёт). MCP-граница (Math.round(12.995*100)/100) даёт тот же 13 —
		// расхождения на этой границе нет. Кол-во 224.805 → round(.,2)=224.81 (#286).
		$items = [
			['name' => 'Штука', 'priceExclVat' => 12.995, 'quantity' => 224.805, 'productId' => '7'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(13.0, $row['PRICE']);   // round(12.995, 2) HALF_UP
		$this->assertSame(224.81, $row['QUANTITY']);  // #286 — округление кол-ва до 2 знаков
	}

	public function testContractIdBoundWhenPositive(): void
	{
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $this->items(), 99);
		$this->assertSame(99, \CCrmDeal::$lastAddFields['UF_CRM_DEAL_DOGOVOR']);
	}

	public function testContractIdOmittedWhenZero(): void
	{
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $this->items(), 0);
		$this->assertArrayNotHasKey('UF_CRM_DEAL_DOGOVOR', \CCrmDeal::$lastAddFields);
	}

	public function testValidDocumentDateSetsBeginDate(): void
	{
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $this->items(), 0, '15.03.2025');

		$this->assertArrayNotHasKey('warnings', $res);
		// BEGINDATE собрана из даты документа РОВНО на 09:00 (бизнес-правило).
		$this->assertSame('15.03.2025 09:00:00', \CCrmDeal::$lastAddFields['BEGINDATE']);
	}

	/** Регрессия #113: непарсибельная/некалендарная дата → warning, не молчаливый now(). */
	public function testUnparseableDocumentDateAddsWarning(): void
	{
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $this->items(), 0, '99.99.9999');

		$this->assertGreaterThan(0, $res['dealId']); // сделка всё равно создана
		$this->assertContains('document_date_unparsed', $res['warnings']);
	}

	public function testProductRowsFailureAddsWarning(): void
	{
		\CCrmDeal::$saveRowsReturn = false;
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $this->items());
		$this->assertContains('product_rows_failed', $res['warnings']);
	}

	public function testInvalidBase64FileAddsWarning(): void
	{
		\CRestUtil::$saveFileReturn = false; // saveFile не смог декодировать
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', base64_encode('data'), 'log', $this->items());
		$this->assertContains('invalid_base64_file', $res['warnings']);
	}

	public function testFileAttachFailureAddsWarning(): void
	{
		\CCrmDeal::$updateReturn = false; // Update сделки с файлом не прошёл
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', base64_encode('data'), 'log', $this->items());
		$this->assertContains('file_attach_failed', $res['warnings']);
	}

	/** #103: недоверенное имя файла санитизируется перед CRestUtil::saveFile. */
	public function testFileNameSanitizedBeforeSaveFile(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 5, 'name' => 'x'];
		$c = new ProcureDeal();
		// path-traversal + NUL control-символ + неразрешённое расширение .php
		$c->createAction(1, 2, "../../etc/pa\x00sswd.php", base64_encode('data'), 'log', $this->items());

		// saveFile получает [имя, контент] — имя без пути/control, расширение нейтрализовано.
		$this->assertSame('passwd.bin', \CRestUtil::$lastArg[0]);
	}

	/** Кириллица в имени транслитерируется в латиницу: Б24 (CFile) выкидывает не-ASCII из
	 *  имени вложения, поэтому приводим к осмысленному ASCII заранее («Профтейп» → «Profteyp»). */
	public function testCyrillicFileNameTransliterated(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 6, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'Профтейп-byn.pdf', base64_encode('data'), 'log', $this->items());
		$this->assertSame('Profteyp-byn.pdf', \CRestUtil::$lastArg[0]);
	}

	/** Транслит смешанного имени: кириллица → латиница, не-ASCII («№») срезается, цифры/пробел целы. */
	public function testMixedCyrillicLatinFileNameTransliterated(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 61, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'Счёт №5.pdf', base64_encode('data'), 'log', $this->items());
		$this->assertSame('Schet 5.pdf', \CRestUtil::$lastArg[0]);
	}

	/** Имя только из непереводимых символов (Ъ/Ь) → base схлопывается в пустоту → fallback «document». */
	public function testFileNameCollapsingToEmptyFallsBackToDocument(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 62, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'ъъь.pdf', base64_encode('data'), 'log', $this->items());
		$this->assertSame('document.pdf', \CRestUtil::$lastArg[0]);
	}

	/** #103: двойное расширение — итоговое (последнее) решает; .php → .bin. */
	public function testDoubleExtensionNeutralised(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 7, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'report.pdf.php', base64_encode('data'), 'log', $this->items());
		$this->assertSame('report.pdf.bin', \CRestUtil::$lastArg[0]); // .php не в whitelist → .bin
	}

	/** #103: юникод-«слэши» (U+2215/U+FF0F) трактуются как разделитель пути и срезаются. */
	public function testUnicodeSlashStripped(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 8, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, "a\u{2215}b\u{FF0F}evil.pdf", base64_encode('data'), 'log', $this->items());
		$this->assertSame('evil.pdf', \CRestUtil::$lastArg[0]);
	}

	/** #103: длинное кириллическое имя обрезается по символам (валидный UTF-8), расширение цело. */
	public function testLongCyrillicNameTruncatedWithoutBrokenUtf8(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 9, 'name' => 'x'];
		$c = new ProcureDeal();
		$c->createAction(1, 2, str_repeat('Я', 300).'.pdf', base64_encode('data'), 'log', $this->items());
		$saved = \CRestUtil::$lastArg[0];
		$this->assertStringEndsWith('.pdf', $saved);
		$this->assertSame($saved, mb_convert_encoding($saved, 'UTF-8', 'UTF-8')); // не побит на полусимволе
		$this->assertLessThanOrEqual(200, mb_strlen($saved, 'UTF-8'));
	}

	/**
	 * Регрессия #99 (by-ref): file Update + timeline onCreate принимают второй
	 * параметр ПО ССЫЛКЕ. Контроллер обязан передавать ПЕРЕМЕННУЮ-массив, иначе
	 * PHP выдаст «Only variables should be passed by reference» → тест упадёт
	 * (phpunit.xml: failOnNotice/failOnWarning). Здесь оба пути отрабатывают
	 * штатно (файл прикреплён, таймлайн записан) и НЕ дают warnings.
	 */
	public function testByRefFileUpdateAndTimelineOnCreate(): void
	{
		\CRestUtil::$saveFileReturn = ['ID' => 9, 'name' => 'f.pdf'];
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', base64_encode('двоичные данные'), 'лог обработки', $this->items());

		$this->assertSame([], $c->errorCodes());
		$this->assertArrayNotHasKey('warnings', $res);

		// by-ref вызовы реально получили массивы-поля.
		$this->assertArrayHasKey('UF_CRM_DEAL_SH_PRCHS_AI_FILE', \CCrmDeal::$lastUpdateFields);
		$this->assertSame('лог обработки', \Bitrix\Crm\Timeline\CommentController::$lastOnCreate['COMMENT']);
		$this->assertSame(\CCrmOwnerType::Deal, \Bitrix\Crm\Timeline\CommentController::$lastOnCreate['ENTITY_TYPE_ID']);
	}

	/** Исключение в таймлайне не валит сделку — фиксируется как warning. */
	public function testTimelineExceptionAddsWarning(): void
	{
		\Bitrix\Crm\Timeline\CommentEntry::$throwOnCreate = true;
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'лог', $this->items());

		$this->assertGreaterThan(0, $res['dealId']); // сделка создана, несмотря на сбой
		$this->assertContains('timeline_comment_failed', $res['warnings']);
	}

	/** Коммент не создан (id<=0), но без исключения → штатный путь, без warning. */
	public function testTimelineNotCreatedIsNotAWarning(): void
	{
		\Bitrix\Crm\Timeline\CommentEntry::$createReturn = 0;
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'лог', $this->items());

		$this->assertArrayNotHasKey('warnings', $res);
	}

	/**
	 * Позиция с артикулом поставщика, но без сопоставленного товара (productId пуст), —
	 * «не найдено в каталоге» — в сделку НЕ кладётся (см. prompts/main.md, Шаг 4).
	 * Сопоставленная позиция (productId>0) остаётся.
	 */
	public function testUnmatchedArticleItemExcludedFromDeal(): void
	{
		\CCrmDeal::$addReturn = 700;
		$items = [
			['name' => 'Найден',    'priceExclVat' => 10.0, 'quantity' => 1, 'vendorCode' => 'A1', 'productId' => '7'],
			['name' => 'Не найден', 'priceExclVat' => 20.0, 'quantity' => 1, 'vendorCode' => 'A2', 'productId' => null],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$rows = \CCrmDeal::$lastProductRows;
		$this->assertCount(1, $rows);                  // только сопоставленная позиция
		$this->assertSame(7, $rows[0]['PRODUCT_ID']);
		$this->assertSame('Найден', $rows[0]['PRODUCT_NAME']);
	}

	/**
	 * #258: позиция БЕЗ артикула поставщика (нет productId) в сделку НЕ кладётся (свободные строки
	 * PRODUCT_ID=0 больше не создаём). Если других позиций нет — SaveProductRows не зовём, сделка
	 * создаётся + warning no_items_matched.
	 */
	public function testItemWithoutArticleIsNotAdded(): void
	{
		\CCrmDeal::$addReturn = 701;
		$items = [
			['name' => 'Без артикула', 'priceExclVat' => 50.0, 'quantity' => 3],
		];
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$this->assertNull(\CCrmDeal::$lastProductRows); // позиция без productId отброшена
		$this->assertContains('no_items_matched', $res['warnings']);
	}

	/**
	 * Все позиции имеют артикул, но ни одна не сопоставлена → ни одной товарной строки,
	 * SaveProductRows не зовём, сделка всё равно создаётся + warning no_items_matched.
	 */
	public function testAllItemsWithUnmatchedArticleYieldNoItemsWarning(): void
	{
		\CCrmDeal::$addReturn = 702;
		$items = [
			['name' => 'X', 'priceExclVat' => 10.0, 'quantity' => 1, 'vendorCode' => 'A1', 'productId' => null],
			['name' => 'Y', 'priceExclVat' => 20.0, 'quantity' => 1, 'vendorCode' => 'A2', 'productId' => 0],
		];
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$this->assertSame(702, $res['dealId']);
		$this->assertContains('no_items_matched', $res['warnings']);
		$this->assertNull(\CCrmDeal::$lastProductRows); // SaveProductRows не вызывался
	}

	/**
	 * Заголовок сделки — «Импорт прайса от <название компании>». Имя поставщика берётся из
	 * CRM по COMPANY_ID (CCrmCompany::GetListEx); имя файла в заголовок больше не идёт.
	 */
	public function testTitleIsImportPriceFromSupplierName(): void
	{
		\CCrmCompany::$resultQueue[] = [['ID' => 1, 'TITLE' => 'ООО Ромашка']];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'invoice.pdf', '', 'log', $this->items());

		$this->assertSame('Импорт прайса от ООО Ромашка', \CCrmDeal::$lastAddFields['TITLE']);
		$this->assertSame(1, \CCrmCompany::$calls[0]['filter']['=ID']); // искали по ID поставщика
	}

	/** Компания не найдена/без названия → фолбэк «поставщик #N» в заголовке. */
	public function testTitleFallsBackToSupplierIdWhenCompanyMissing(): void
	{
		\CCrmCompany::$resultQueue[] = []; // курсор без строк
		$c = new ProcureDeal();
		$c->createAction(5, 2, 'invoice.pdf', '', 'log', $this->items());

		$this->assertSame('Импорт прайса от поставщик #5', \CCrmDeal::$lastAddFields['TITLE']);
	}

	/**
	 * Заголовок ограничен 255 символами (TITLE сделки — varchar(255)): очень длинное
	 * название компании обрезается, иначе БД усечёт молча / уронит вставку в strict-режиме.
	 */
	public function testLongSupplierNameTruncatesTitleTo255(): void
	{
		\CCrmCompany::$resultQueue[] = [['ID' => 1, 'TITLE' => str_repeat('Я', 300)]];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'invoice.pdf', '', 'log', $this->items());

		$title = \CCrmDeal::$lastAddFields['TITLE'];
		$this->assertSame(255, mb_strlen($title, 'UTF-8'));
		$this->assertStringStartsWith('Импорт прайса от ', $title);
	}

	/**
	 * Несопоставленная позиция (productId пуст) исключается независимо от vendorCode — здесь
	 * артикул-строка «0» (валидный непустой артикул), товар не найден → productId null → отброшена
	 * фильтром empty($item['productId']) (#258).
	 */
	public function testZeroStringVendorCodeUnmatchedIsExcluded(): void
	{
		\CCrmDeal::$addReturn = 703;
		$items = [
			['name' => 'Ноль-артикул', 'priceExclVat' => 10.0, 'quantity' => 1, 'vendorCode' => '0', 'productId' => null],
		];
		$c = new ProcureDeal();
		$res = $c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$this->assertNull(\CCrmDeal::$lastProductRows);          // позиция отброшена
		$this->assertContains('no_items_matched', $res['warnings']);
	}
}
