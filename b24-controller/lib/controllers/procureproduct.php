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
	 * Поиск — строго по ТОЧНОМУ совпадению артикула как есть (один точечный
	 * =PROPERTY-запрос). Подмена раскладки/гомоглифов и LIKE-фолбэк убраны намеренно:
	 * «выбрал → поискал → записал, что не найдено». Несколько найдено → товар с
	 * минимальным ID.
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

		// Точного совпадения нет → товар не найден. Подмену раскладки/гомоглифов и
		// LIKE-фолбэк убрали намеренно: артикул сверяется строго «как есть». Несопоставленную
		// позицию агент в сделку не кладёт, а пишет в лог (см. prompts/main.md, Шаг 4).
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
