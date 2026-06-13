<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Shef\Options\TraitList;
use Shef\Purchase\Config;

/**
 * Поиск товара по артикулу поставщика для procure-ai.
 * REST: shef:purchase.api.procureproduct.findByVendorCode
 */
class ProcureProduct
	extends Engine\Controller
{
	use TraitList\Modules;

	protected static function getModulesList(): array
	{
		return [
			'iblock',
			'catalog',
		];
	}

	public function configureActions(): array
	{
		return [
			'findByVendorCode' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * Ищет активный родительский товар по артикулу поставщика.
	 * Родительский = пустое свойство PURCHASE_69_PARENT_PRODUCT.
	 *
	 * Алгоритм (приоритет скорости):
	 *   1) быстрый путь — точное совпадение 1-в-1 по артикулу как есть (один
	 *      точечный =PROPERTY-запрос; на чистых данных этого достаточно);
	 *   2) фолбэк «по всякому», только если шаг 1 пуст — устойчивость к раскладке
	 *      латиница/кириллица (гомоглифы, напр. «тех 100х25х6000») и к краевым
	 *      пробелам/табам в данных каталога.
	 * Несколько найдено → товар с минимальным ID.
	 *
	 * @param string $vendorCode Артикул поставщика из документа
	 * @return array|null { id, name, vendorCode } | { id: null }
	 */
	public function findByVendorCodeAction(string $vendorCode): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		$vendorCode = trim($vendorCode);
		if($vendorCode === '')
		{
			$this->addError(new Error('Пустой артикул', 'prd:010'));
			return null;
		}

		if(mb_strlen($vendorCode) > 64)
		{
			$this->addError(new Error('Слишком длинный артикул', 'prd:011'));
			return null;
		}

		$iblockId = Config::getCatalogIblockId();

		// Базовые условия: активный родительский товар нужного каталога
		// (родительский = пустое свойство PURCHASE_69_PARENT_PRODUCT).
		$base = [
			'IBLOCK_ID'                            => $iblockId,
			'ACTIVE'                               => 'Y',
			'=PROPERTY_PURCHASE_69_PARENT_PRODUCT' => false,
		];

		// --- Шаг 1. Быстрый путь: точное совпадение 1-в-1 по артикулу как есть.
		// Один точечный =PROPERTY по ОДНОМУ значению (не IN/LIKE по десяткам), поэтому
		// на чистых данных ищется быстро и этого достаточно.
		$exact = \CIBlockElement::GetList(
			['ID' => 'ASC'],                 // мин. ID при дублях
			['=PROPERTY_PURCHASE_ARTICLE' => $vendorCode] + $base,
			false,
			['nTopCount' => 1],
			['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
		);
		if(is_object($exact) && ($row = $exact->Fetch()))
		{
			return self::formatProduct($row);
		}

		// --- Шаг 2. «По всякому» (только если точный 1-в-1 не нашёл) ---
		// Артикул мог быть набран в другой раскладке (латиница/кириллица — гомоглифы,
		// напр. «тех 100х25х6000») или содержать краевые пробелы/табы из выгрузок
		// 1С/Excel («…6000\t»). Каталог большой — фолд в SQL невозможен, поэтому
		// генерируем гомоглиф-варианты.
		$variants = Config::homoglyphVariants($vendorCode);

		// 2a) Точный IN по вариантам — гасит разницу раскладки на чистых данных.
		if(count($variants) > 1)
		{
			$byVariants = \CIBlockElement::GetList(
				['ID' => 'ASC'],
				['=PROPERTY_PURCHASE_ARTICLE' => $variants] + $base,
				false,
				['nTopCount' => 1],
				['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
			);
			if(is_object($byVariants) && ($row = $byVariants->Fetch()))
			{
				return self::formatProduct($row);
			}
		}

		// 2b) LIKE-подстрока по каждому варианту + сверка foldHomoglyphs() (гасит
		// регистр, раскладку и краевые пробелы) — добивает «грязные» данные. Путь
		// редкий и самый дорогой, поэтому последний.
		$needleFold = Config::foldHomoglyphs($vendorCode);
		foreach($variants as $variant)
		{
			$like = \CIBlockElement::GetList(
				['ID' => 'ASC'],              // мин. ID при дублях
				['%PROPERTY_PURCHASE_ARTICLE' => $variant] + $base, // LIKE %variant%
				false,
				['nTopCount' => 50],
				['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
			);
			if(!is_object($like))
			{
				continue;
			}
			while($row = $like->Fetch())
			{
				if(Config::foldHomoglyphs((string)$row['PROPERTY_PURCHASE_ARTICLE_VALUE']) === $needleFold)
				{
					return self::formatProduct($row);
				}
			}
		}

		return ['id' => null];
	}

	/**
	 * Унифицированный ответ метода по найденной строке GetList.
	 *
	 * @param array $row строка с ключами ID, NAME, PROPERTY_PURCHASE_ARTICLE_VALUE
	 * @return array{ id:int, name:string, vendorCode:string }
	 */
	private static function formatProduct(array $row): array
	{
		return [
			'id'         => (int)$row['ID'],
			'name'       => (string)$row['NAME'],
			'vendorCode' => (string)$row['PROPERTY_PURCHASE_ARTICLE_VALUE'],
		];
	}
}
