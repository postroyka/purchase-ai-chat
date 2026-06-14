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

	public function testProductNotFoundReturnsIdNull(): void
	{
		// Артикул из цифр → гомоглиф-вариантов нет, только точный + LIKE-фолбэк,
		// все курсоры пустые → id: null.
		$c = new ProcureProduct();
		$this->assertSame(['id' => null], $c->findByVendorCodeAction('999999'));
	}
}
