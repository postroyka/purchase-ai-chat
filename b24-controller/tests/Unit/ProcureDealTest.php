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

	public function testEmptyItemsReturnDeal020(): void
	{
		$c = new ProcureDeal();
		$this->assertNull($c->createAction(1, 1, 'f.pdf', '', 'log', []));
		$this->assertSame(['deal:020'], $c->errorCodes());
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
		$this->assertSame(2.0, $row['QUANTITY']);
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
