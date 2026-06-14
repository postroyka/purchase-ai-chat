<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\Purchase\Config;

/**
 * Регрессии на свёртку гомоглифов (config.php) — чистая логика, без Bitrix.
 * Эти функции лежат в основе устойчивого к раскладке поиска договоров/артикулов.
 */
final class ConfigHomoglyphTest extends TestCase
{
	public function testFoldEqualsAcrossLatinAndCyrillicHomoglyphs(): void
	{
		// «АВС» (кириллица) и «ABC» (латиница) выглядят одинаково → fold равны.
		$this->assertSame(
			Config::foldHomoglyphs('АВС'),
			Config::foldHomoglyphs('ABC'),
			'Кириллические и латинские двойники должны сворачиваться к одному виду'
		);
	}

	public function testFoldTrimsEdges(): void
	{
		$this->assertSame(
			Config::foldHomoglyphs('ABC'),
			Config::foldHomoglyphs('  ABC  '),
			'foldHomoglyphs должен срезать краевые пробелы'
		);
	}

	public function testFoldIsCaseInsensitive(): void
	{
		$this->assertSame(
			Config::foldHomoglyphs('ABC'),
			Config::foldHomoglyphs('abc'),
			'foldHomoglyphs должен приводить к верхнему регистру'
		);
	}

	public function testFoldKeepsGenuinelyDifferentStringsDifferent(): void
	{
		$this->assertNotSame(
			Config::foldHomoglyphs('ABC'),
			Config::foldHomoglyphs('ABD')
		);
	}

	public function testFoldFoldsYoToE(): void
	{
		// Ё → E (карта в foldHomoglyphs).
		$this->assertSame(
			Config::foldHomoglyphs('ЁЖ'),
			Config::foldHomoglyphs('ЕЖ')
		);
	}

	public function testVariantsContainBothLayouts(): void
	{
		// «BE» — обе буквы имеют кириллических двойников (В, Е) → 2^2 = 4 варианта.
		$variants = Config::homoglyphVariants('BE');
		$this->assertContains('BE', $variants, 'исходная (латиница)');
		$this->assertContains('ВЕ', $variants, 'оба символа в кириллице');
		$this->assertCount(4, $variants);
	}

	public function testVariantsForStringWithoutHomoglyphsIsItself(): void
	{
		// В строке нет «спорных» букв → ровно она сама.
		$this->assertSame(['12345'], Config::homoglyphVariants('12345'));
	}

	public function testVariantsForEmptyStringIsSingleEmpty(): void
	{
		$this->assertSame([''], Config::homoglyphVariants(''));
	}

	public function testVariantsAtExactCapAreNotCollapsed(): void
	{
		// 6 «спорных» букв → 2^6 = 64 = дефолтный $cap. Условие схлопывания строгое
		// (> $cap), поэтому ровно 64 варианта ДОЛЖНЫ остаться. Фиксирует границу:
		// если кто-то поменяет «>» на «>=», тест упадёт.
		$this->assertCount(64, Config::homoglyphVariants('ABEKMO'));
	}

	public function testVariantsCollapseToOriginalWhenExceedingDefaultCap(): void
	{
		// 7 «спорных» букв → 2^7 = 128 > дефолтный $cap=64 → только исходная строка
		// (защита от комбинаторного взрыва).
		$input = 'ABEKMOP';
		$this->assertSame([$input], Config::homoglyphVariants($input));
	}

	public function testVariantsRespectExplicitCap(): void
	{
		// $cap=2: после второй «спорной» буквы 4 > 2 → схлопывается к исходной.
		$this->assertSame(['ABE'], Config::homoglyphVariants('ABE', 2));
	}
}
