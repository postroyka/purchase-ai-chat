<?php
namespace Shef\Purchase;

use Bitrix\Main\Config\Option;

/**
 * Централизованный доступ к конфигурируемым параметрам модуля shef.purchase.
 * Все дефолты живут здесь — менять только здесь, а не в каждом контроллере.
 *
 * Переопределить через «Настройки → Настройки модулей → Закупки»:
 *   B24_CATALOG_IBLOCK_ID      — ID инфоблока каталога товаров (умолч. 15)
 *   B24_DEAL_CATEGORY_ID       — ID воронки «Закупки» (умолч. 1)
 *   B24_DEAL_DEFAULT_STAGE_ID  — стадия новой сделки (умолч. C1:NEW)
 *   B24_UNIT_OKEI_SHT          — ОКЕИ-код «штука» (умолч. 796)
 */
class Config
{
	/** ID инфоблока каталога товаров (iblock). */
	public static function getCatalogIblockId(): int
	{
		return (int)Option::get('shef.purchase', 'B24_CATALOG_IBLOCK_ID', 15);
	}

	/** ID воронки CRM-сделок для закупок (CATEGORY_ID). */
	public static function getDealCategoryId(): int
	{
		return (int)Option::get('shef.purchase', 'B24_DEAL_CATEGORY_ID', 1);
	}

	/** STAGE_ID новой сделки (например C1:NEW). */
	public static function getDealDefaultStageId(): string
	{
		return (string)Option::get('shef.purchase', 'B24_DEAL_DEFAULT_STAGE_ID', 'C1:NEW');
	}

	/**
	 * ОКЕИ-код единицы измерения «штука».
	 * Передаётся как MEASURE_CODE в CCrmDeal::SaveProductRows.
	 * 796 — стандартный код ОКЕИ; меняется только при нестандартной настройке каталога.
	 */
	public static function getUnitOkeiSht(): int
	{
		return (int)Option::get('shef.purchase', 'B24_UNIT_OKEI_SHT', 796);
	}

	/**
	 * Пары визуально совпадающих букв латиница ↔ кириллица (оба регистра).
	 * Номера договоров и артикулы (напр. «243Э20», «тех 100х25х6000») оператор
	 * мог набрать в любой раскладке; в Unicode это РАЗНЫЕ символы, и точное
	 * совпадение тихо ломается. Используется для гомоглиф-устойчивого поиска.
	 *
	 * Размещено в Config (а не в отдельном файле-хелпере), т.к. деплой выкладывает
	 * только config.php + procure*.php — отдельный класс на коробку не попал бы.
	 */
	private const HOMOGLYPH_PAIRS = [
		['A', 'А'], ['a', 'а'], ['B', 'В'], ['E', 'Е'], ['e', 'е'],
		['K', 'К'], ['k', 'к'], ['M', 'М'], ['m', 'м'], ['H', 'Н'], ['O', 'О'], ['o', 'о'],
		['P', 'Р'], ['p', 'р'], ['C', 'С'], ['c', 'с'], ['T', 'Т'], ['t', 'т'], ['Y', 'У'],
		['y', 'у'], ['X', 'Х'], ['x', 'х'], ['I', 'І'], ['i', 'і'],
		['J', 'Ј'], ['j', 'ј'], ['S', 'Ѕ'], ['s', 'ѕ'],
	];

	/**
	 * Каноническая форма строки для сравнения «на глаз»: верхний регистр +
	 * спорные кириллические буквы сведены к латинским. Две строки, выглядящие
	 * одинаково, дают равный результат. Сравнение: foldHomoglyphs(a) === foldHomoglyphs(b).
	 */
	public static function foldHomoglyphs(string $s): string
	{
		$s = mb_strtoupper(trim($s), 'UTF-8');
		static $map = [
			'А' => 'A', 'В' => 'B', 'Е' => 'E', 'Ё' => 'E', 'К' => 'K', 'М' => 'M',
			'Н' => 'H', 'О' => 'O', 'Р' => 'P', 'С' => 'C', 'Т' => 'T', 'У' => 'Y',
			'Х' => 'X', 'І' => 'I', 'Ј' => 'J', 'Ѕ' => 'S',
		];
		return strtr($s, $map);
	}

	/**
	 * Все варианты строки с заменой спорных букв на их двойники (в обе стороны).
	 * Для точного БД-поиска (например артикула через `=PROPERTY ... IN (...)`),
	 * где свести обе стороны к канону нельзя — генерируем кандидатов.
	 * При комбинаторном взрыве (> $cap вариантов) возвращаем только исходную строку.
	 *
	 * @return string[] список уникальных вариантов (всегда включает исходный)
	 */
	public static function homoglyphVariants(string $s, int $cap = 64): array
	{
		$s = trim($s);
		if($s === '')
		{
			return [''];
		}

		static $twin = null;
		if($twin === null)
		{
			$twin = [];
			foreach(self::HOMOGLYPH_PAIRS as [$lat, $cyr])
			{
				$twin[$lat] = $cyr;
				$twin[$cyr] = $lat;
			}
		}

		$chars    = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
		$variants = [''];
		foreach($chars as $ch)
		{
			$options = isset($twin[$ch]) ? [$ch, $twin[$ch]] : [$ch];
			$next    = [];
			foreach($variants as $prefix)
			{
				foreach($options as $opt)
				{
					$next[] = $prefix.$opt;
				}
			}
			if(count($next) > $cap)
			{
				// Защита от взрыва на длинных строках с множеством букв.
				return [$s];
			}
			$variants = $next;
		}

		return array_values(array_unique($variants));
	}
}
