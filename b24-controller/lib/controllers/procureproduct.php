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
	 * Совпадение устойчиво к латинице/кириллице (гомоглифы, напр. «тех 100х25х6000»).
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

		// Артикул мог быть набран в латинице или кириллице (напр. «тех 100х25х6000»);
		// каталог большой — фолд в SQL невозможен, поэтому генерируем гомоглиф-варианты
		// и матчим их через IN. Один вариант → строка, несколько → массив (=PROPERTY IN).
		$articleVariants = Config::homoglyphVariants($vendorCode);
		$articleFilter   = count($articleVariants) === 1 ? $articleVariants[0] : $articleVariants;

		$filter = [
			'IBLOCK_ID'                            => $iblockId,
			'ACTIVE'                               => 'Y',
			'=PROPERTY_PURCHASE_ARTICLE'           => $articleFilter,
			'=PROPERTY_PURCHASE_69_PARENT_PRODUCT' => false, // пустое → родительский
		];

		$dbResult = \CIBlockElement::GetList(
			['ID' => 'ASC'],          // мин. ID при дублях
			$filter,
			false,
			['nTopCount' => 1],
			['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
		);

		if(is_object($dbResult) && ($fields = $dbResult->Fetch()))
		{
			return [
				'id'         => (int)$fields['ID'],
				'name'       => (string)$fields['NAME'],
				'vendorCode' => (string)$fields['PROPERTY_PURCHASE_ARTICLE_VALUE'],
			];
		}

		return ['id' => null];
	}
}
