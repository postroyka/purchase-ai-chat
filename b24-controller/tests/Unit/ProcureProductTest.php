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

	public function testHomoglyphVariantFoundViaExactInStep2a(): void
	{
		// Артикул в БД латиницей «ABC», в документе кириллицей «АВС»: точный шаг 1
		// мимо, а шаг 2a (=PROPERTY IN [варианты]) должен найти по двойнику.
		\CIBlockElement::$resultQueue = [
			[],                                                                       // шаг 1 (точный) — мимо
			[['ID' => 7, 'NAME' => 'Уголок', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => 'ABC']], // шаг 2a — попадание
		];

		$c = new ProcureProduct();
		$res = $c->findByVendorCodeAction('АВС'); // кириллица

		$this->assertSame(7, $res['id']);
		$this->assertSame('ABC', $res['vendorCode']);
		// Шаг 2a ищет IN по списку гомоглиф-вариантов, среди которых есть латинский «ABC».
		$inFilter = \CIBlockElement::$calls[1]['filter']['=PROPERTY_PURCHASE_ARTICLE'];
		$this->assertIsArray($inFilter);
		$this->assertContains('ABC', $inFilter);
	}

	public function testDirtyCatalogValueFoundViaLikeStep2b(): void
	{
		// Значение в каталоге с краевыми пробелами « SKU »: точный (шаг 1) и IN
		// по вариантам (шаг 2a) мимо, добивает LIKE+foldHomoglyphs (шаг 2b).
		\CIBlockElement::$resultQueue = [
			[],                                                                          // шаг 1 — мимо
			[],                                                                          // шаг 2a — мимо
			[['ID' => 9, 'NAME' => 'Болт', 'PROPERTY_PURCHASE_ARTICLE_VALUE' => ' SKU ']], // шаг 2b (LIKE) — попадание
		];

		$c = new ProcureProduct();
		$res = $c->findByVendorCodeAction('SKU');

		$this->assertSame(9, $res['id']);
		// Найдено именно через LIKE-ветку: запрос вёлся по подстроке (%PROPERTY...).
		$likeFilter = \CIBlockElement::$calls[2]['filter'];
		$this->assertArrayHasKey('%PROPERTY_PURCHASE_ARTICLE', $likeFilter);
	}

	public function testProductNotFoundReturnsIdNull(): void
	{
		// Артикул из цифр → гомоглиф-вариантов нет, только точный + LIKE-фолбэк,
		// все курсоры пустые → id: null.
		$c = new ProcureProduct();
		$this->assertSame(['id' => null], $c->findByVendorCodeAction('999999'));
	}
}
