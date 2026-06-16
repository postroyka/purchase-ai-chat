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

	public function testInvalidSupplierIdReturnsDeal010(): void
	{
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(0, 1, 'f.pdf', '', 'log', $this->items()));
		$this->assertSame(['deal:010'], $c->errorCodes());
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

		// Бизнес-правила позиции: TAX_RATE=20, TAX_INCLUDED=Y, единица «шт», цена как есть.
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

	public function testNegativePriceAndQuantityAreClamped(): void
	{
		\CCrmDeal::$addReturn = 1;
		$items = [['name' => 'X', 'priceExclVat' => -5.0, 'quantity' => 0]];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(0.0, $row['PRICE']);   // max(0.0, -5.0) → float 0.0
		// Кол-во <=0 → 1 (контроллер присваивает int-литерал; тип не важен — Bitrix
		// принимает оба, поэтому сверяем значение, а не тип).
		$this->assertEquals(1, $row['QUANTITY']);
	}

	public function testPriceRoundedToKopecksAndQuantityToInteger(): void
	{
		// Прямой REST в обход Zod: float-погрешность цены (>2 знаков) и дробное кол-во.
		// #101 — цена округляется до копеек, кол-во до целого («шт»), иначе сумма
		// сделки в Б24 разойдётся с бумажным счётом.
		$items = [
			['name' => 'Кабель', 'priceExclVat' => 12.991, 'quantity' => 1.5, 'productId' => '7'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(12.99, $row['PRICE']);  // round(12.991, 2)
		$this->assertSame(2.0, $row['QUANTITY']);  // round(1.5) — целое значение, тип float
	}

	public function testHalfKopeckRoundsHalfUpAndZeroDotFourQuantityClampsToOne(): void
	{
		// Краевые случаи прямого REST: PHP round() — HALF_UP (12.995 → 13.00, как
		// бумажный счёт). MCP-граница (Math.round(12.995*100)/100) даёт тот же 13 —
		// расхождения на этой границе нет. Кол-во 0.4 → round=0 → clamp 1.0.
		$items = [
			['name' => 'Штука', 'priceExclVat' => 12.995, 'quantity' => 0.4, 'productId' => '7'],
		];
		$c = new ProcureDeal();
		$c->createAction(1, 2, 'f.pdf', '', 'log', $items);

		$row = \CCrmDeal::$lastProductRows[0];
		$this->assertSame(13.0, $row['PRICE']);   // round(12.995, 2) HALF_UP
		$this->assertSame(1.0, $row['QUANTITY']);  // round(0.4)=0 → clamp 1.0
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
}
