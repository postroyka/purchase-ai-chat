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
}
