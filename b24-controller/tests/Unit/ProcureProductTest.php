<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\Purchase\Controllers\ProcureProduct;
use Shef\Purchase\Tests\Stub;

/**
 * Поиск товара по артикулу: guard-коды и краевой пробел/таб (trim, #68).
 */
final class ProcureProductTest extends TestCase
{
	protected function setUp(): void
	{
		Stub::reset();
	}

	public function testEmptyVendorCodeReturnsPrd010(): void
	{
		$c = new ProcureProduct();
		// только пробелы/таб → после trim пусто.
		$this->assertNull($c->findByVendorCodeAction("  \t "));
		$this->assertSame(['prd:010'], $c->errorCodes());
	}

	public function testOverlongVendorCodeReturnsPrd011(): void
	{
		$c = new ProcureProduct();
		$this->assertNull($c->findByVendorCodeAction(str_repeat('A', 65)));
		$this->assertContains('prd:011', $c->errorCodes());
	}

	public function testEdgeWhitespaceTrimmedBeforeExactLookup(): void
	{
		// Артикул из выгрузки 1С/Excel с краевым табом «\tSKU ».
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'SKU'],
		];

		$c = new ProcureProduct();
		$res = $c->findByVendorCodeAction("\tSKU ");

		$this->assertSame(7, $res['id']);
		$this->assertSame('Болт', $res['name']);
		$this->assertSame('SKU', $res['vendorCode']);

		// Быстрый путь (шаг 1) должен искать ОЧИЩЕННЫЙ артикул, а не «\tSKU ».
		$exactFilter = \CIBlockElement::$calls[0]['filter'];
		$this->assertSame('SKU', $exactFilter['=PROPERTY_PURCHASE_ARTICLE']);
	}

	public function testOnlyExactLookupNoFallback(): void
	{
		// Шаг 2 (подмена раскладки/гомоглифы + LIKE) убран: при промахе делается РОВНО
		// один точечный =PROPERTY-запрос и сразу id:null. Латиница в БД vs кириллица в
		// документе теперь НЕ совпадают — так и задумано («выбрал-поискал-записал»).
		$c = new ProcureProduct();
		$this->assertSame(['id' => null], $c->findByVendorCodeAction('АВС'));
		$this->assertCount(1, \CIBlockElement::$calls); // ровно один запрос, без фолбэков
		$this->assertArrayHasKey('=PROPERTY_PURCHASE_ARTICLE', \CIBlockElement::$calls[0]['filter']);
	}

	public function testProductNotFoundReturnsIdNull(): void
	{
		// Только точное совпадение; курсор пуст → id: null.
		$c = new ProcureProduct();
		$this->assertSame(['id' => null], $c->findByVendorCodeAction('999999'));
	}

	public function testSingleMatchHasNoMultiFlag(): void
	{
		\CIBlockElement::$resultQueue[] = [['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'SKU']];
		$c = new ProcureProduct();
		$res = $c->findByVendorCodeAction('SKU');
		$this->assertSame(7, $res['id']);
		$this->assertArrayNotHasKey('multi', $res);
	}

	public function testMultiMatchSetsMultiFlagAndPicksMinId(): void
	{
		// Артикул совпал с >1 товаром → берём min(id)=7 + multi:true (#195).
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'SKU'],
			['ID' => 9, 'NAME' => 'Болт-дубль', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'SKU'],
		];
		$c = new ProcureProduct();
		$res = $c->findByVendorCodeAction('SKU');
		$this->assertSame(7, $res['id']);
		$this->assertTrue($res['multi']);
	}

	// ── Батч-поиск findByVendorCodes (#262, рычаг №1) ──────────────────────────

	public function testBatchEmptyListReturnsPrd013(): void
	{
		$c = new ProcureProduct();
		// Список из одних «пустых» элементов → после отсева пусто → prd:013.
		$this->assertNull($c->findByVendorCodesAction(['', "  \t "]));
		$this->assertSame(['prd:013'], $c->errorCodes());
	}

	public function testBatchNonStringElementReturnsPrd012(): void
	{
		$c = new ProcureProduct();
		$this->assertNull($c->findByVendorCodesAction(['OK', 123]));
		$this->assertContains('prd:012', $c->errorCodes());
	}

	public function testBatchOverlongElementReturnsPrd011(): void
	{
		$c = new ProcureProduct();
		$this->assertNull($c->findByVendorCodesAction(['OK', str_repeat('A', 65)]));
		$this->assertContains('prd:011', $c->errorCodes());
	}

	public function testBatchTooManyReturnsPrd014(): void
	{
		$c = new ProcureProduct();
		$codes = array_map(static fn(int $i): string => 'SKU-' . $i, range(1, 51));
		$this->assertNull($c->findByVendorCodesAction($codes));
		$this->assertContains('prd:014', $c->errorCodes());
	}

	public function testBatchSingleInQueryWithTrimmedDedupedCodes(): void
	{
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'A'],
		];
		$c = new ProcureProduct();
		// «\tA », «A» — дубликаты после trim; «B» — отдельный.
		$c->findByVendorCodesAction(["\tA ", 'A', 'B']);

		// Ровно ОДИН запрос (батч), фильтр — IN по уникальным очищенным артикулам.
		$this->assertCount(1, \CIBlockElement::$calls);
		$this->assertSame(['A', 'B'], \CIBlockElement::$calls[0]['filter']['=PROPERTY_PURCHASE_ARTICLE']);
	}

	public function testBatchReturnsListFoundAndNotFound(): void
	{
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'A'],
			// для 'B' строки нет → должен попасть как {vendorCode, id:null}
		];
		$c = new ProcureProduct();
		// Список в порядке запроса: [0] = A (найден), [1] = B (не найден).
		$res = $c->findByVendorCodesAction(['A', 'B']);

		$this->assertSame(['id' => 7, 'name' => 'Болт', 'vendorCode' => 'A'], $res[0]);
		$this->assertSame(['vendorCode' => 'B', 'id' => null], $res[1]);
	}

	public function testBatchMultiFlagPerArticlePicksMinId(): void
	{
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'A'],
			['ID' => 9, 'NAME' => 'Болт-дубль', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'A'],
			['ID' => 3, 'NAME' => 'Гайка', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'B'],
		];
		$c = new ProcureProduct();
		$res = $c->findByVendorCodesAction(['A', 'B']);

		$this->assertSame(7, $res[0]['id']);   // min id среди дублей A
		$this->assertTrue($res[0]['multi']);
		$this->assertSame(3, $res[1]['id']);
		$this->assertArrayNotHasKey('multi', $res[1]);
	}

	public function testBatchNumericVendorCodesStayStringsInList(): void
	{
		// Числовые артикулы (как 654441/76062224 из реальных тестов): результат —
		// список объектов, vendorCode остаётся строкой; не найденный — тоже строкой.
		\CIBlockElement::$resultQueue[] = [
			['ID' => 7, 'NAME' => 'Шпатлёвка', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => '654441'],
		];
		$c = new ProcureProduct();
		$res = $c->findByVendorCodesAction(['654441', '76062224']);

		$this->assertCount(2, $res);
		$this->assertSame(['id' => 7, 'name' => 'Шпатлёвка', 'vendorCode' => '654441'], $res[0]);
		$this->assertSame(['vendorCode' => '76062224', 'id' => null], $res[1]);
		$this->assertIsString($res[1]['vendorCode']);
	}
}
