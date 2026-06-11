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
}
