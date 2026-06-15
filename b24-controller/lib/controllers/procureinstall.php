<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Shef\Options\TraitList;
use Shef\Purchase\Config;

/**
 * Самонастройка схемы Bitrix24 для procure-ai.
 * REST: shef:purchase.api.procureinstall.ensureSchema
 *
 * Зачем: чтобы приложение само доводило коробку до рабочего состояния (особенно свежий или
 * тестовый портал), а не требовало ручного создания полей. Идемпотентно: поле создаётся
 * ТОЛЬКО если его нет — повторный вызов ничего не дублирует.
 *
 * ⚠️ МУТИРУЮЩИЙ метод (создаёт пользовательские поля). Только ДОБАВЛЯЕТ — ничего не меняет и
 * не удаляет. НЕ входит в read-only post-deploy health-чек (тот обязан быть без сайд-эффектов).
 *
 * Почему REST-контроллер, а не install.php модуля: деплой выкладывает только procure*.php +
 * config.php (см. README). Файл procureinstall.php подходит под маску и доступен по REST
 * автоматически (namespace \Shef\Purchase\Controllers).
 *
 * Это самостоятельный примитив: в процесс установки приложения он пока НЕ подключён —
 * страница установки UI (ui/app/pages/install.vue) лишь подтверждает установку
 * (installFinish) и поля не создаёт. Донастройку при установке добавим, когда будем
 * расширять приложение; до тех пор метод при необходимости вызывают вручную/из бэкенда.
 *
 * Объём: создаём кастомные поля СДЕЛКИ — их достаточно, чтобы procuredeal.create не падал.
 * Структуру каталога (свойства товаров) и воронку НЕ создаём молча: тип
 * PURCHASE_69_PARENT_PRODUCT и ID инфоблоков специфичны для коробки. Их отдаём чек-листом —
 * оператор обеспечивает сам (см. checklist в ответе).
 */
class ProcureInstall
	extends Engine\Controller
{
	use TraitList\Modules;

	/**
	 * Кастомные пользовательские поля СДЕЛКИ, на которых завязан procuredeal.create.
	 * Коды фиксированы (их пишет контроллер сделки) — не конфигурируются.
	 *   UF_CRM_DEAL_SH_PRCHS_AI_FILE — файл документа (CRestUtil::saveFile → file UF)
	 *   UF_CRM_DEAL_DOGOVOR          — привязка договора (хранит идентификатор; string —
	 *                                  терпимо к буквенно-цифровым номерам)
	 */
	private const DEAL_USERFIELDS = [
		[
			'FIELD_NAME'   => 'UF_CRM_DEAL_SH_PRCHS_AI_FILE',
			'USER_TYPE_ID' => 'file',
			'LABEL'        => 'Документ procure-ai (счёт/накладная)',
		],
		[
			'FIELD_NAME'   => 'UF_CRM_DEAL_DOGOVOR',
			'USER_TYPE_ID' => 'string',
			'LABEL'        => 'Договор (procure-ai)',
		],
	];

	protected static function getModulesList(): array
	{
		return ['crm'];
	}

	public function configureActions(): array
	{
		return [
			'ensureSchema' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * Идемпотентно создаёт недостающие кастомные поля сделки и отдаёт отчёт + чек-лист
	 * предусловий, которые оператор обеспечивает вручную.
	 *
	 * @return array|null {
	 *   ok: bool,            // все нужные поля на месте и ничего не упало
	 *   created: string[],   // коды полей, созданных этим вызовом
	 *   existing: string[],  // коды полей, которые уже были
	 *   failed: string[],    // коды полей, которые создать не удалось
	 *   checklist: array     // предусловия для ручной проверки (каталог/воронка/договоры/реквизит)
	 * } | null при сбое загрузки модулей
	 */
	public function ensureSchemaAction(): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		$created  = [];
		$existing = [];
		$failed   = [];

		foreach(self::DEAL_USERFIELDS as $uf)
		{
			$code = $uf['FIELD_NAME'];
			if(self::dealUserFieldExists($code))
			{
				$existing[] = $code;
				continue;
			}
			if(self::addDealUserField($uf))
			{
				$created[] = $code;
			}
			else
			{
				$failed[] = $code;
			}
		}

		return [
			'ok'        => $failed === [],
			'created'   => $created,
			'existing'  => $existing,
			'failed'    => $failed,
			'checklist' => self::prerequisitesChecklist(),
		];
	}

	/** Есть ли пользовательское поле сделки с таким кодом. */
	private static function dealUserFieldExists(string $fieldName): bool
	{
		$res = \CUserTypeEntity::GetList(
			[],
			['ENTITY_ID' => 'CRM_DEAL', 'FIELD_NAME' => $fieldName]
		);
		return is_object($res) && (bool)$res->Fetch();
	}

	/** Создать пользовательское поле сделки. @return bool успех (вернулся id > 0). */
	private static function addDealUserField(array $uf): bool
	{
		$entity = new \CUserTypeEntity();
		$id = $entity->Add([
			'ENTITY_ID'         => 'CRM_DEAL',
			'FIELD_NAME'        => $uf['FIELD_NAME'],
			'USER_TYPE_ID'      => $uf['USER_TYPE_ID'],
			'XML_ID'            => $uf['FIELD_NAME'],
			'MULTIPLE'          => 'N',
			'MANDATORY'         => 'N',
			'SHOW_FILTER'       => 'N',
			'SHOW_IN_LIST'      => 'Y',
			'EDIT_IN_LIST'      => 'Y',
			'EDIT_FORM_LABEL'   => ['ru' => $uf['LABEL'], 'en' => $uf['FIELD_NAME']],
			'LIST_COLUMN_LABEL' => ['ru' => $uf['LABEL'], 'en' => $uf['FIELD_NAME']],
		]);
		return (int)$id > 0;
	}

	/**
	 * Предусловия, которые НЕ создаём автоматически (специфичны для коробки), —
	 * отдаём списком, чтобы оператор проверил/создал их сам.
	 *
	 * @return array<int,array{key:string,hint:string}>
	 */
	private static function prerequisitesChecklist(): array
	{
		$iblockId   = Config::getCatalogIblockId();
		$categoryId = Config::getDealCategoryId();
		$stageId    = Config::getDealDefaultStageId();

		return [
			[
				'key'  => 'catalog_iblock',
				'hint' => "Каталог товаров: инфоблок #{$iblockId} (B24_CATALOG_IBLOCK_ID) со "
					. 'строковым свойством PURCHASE_ARTICLE (артикул поставщика) и свойством-'
					. 'признаком родителя PURCHASE_69_PARENT_PRODUCT (пустое = родительский товар).',
			],
			[
				'key'  => 'deal_pipeline',
				'hint' => "Воронка сделок «Закупки»: CATEGORY_ID #{$categoryId} "
					. "(B24_DEAL_CATEGORY_ID) со стадией {$stageId} (B24_DEAL_DEFAULT_STAGE_ID).",
			],
			[
				'key'  => 'contract_list',
				'hint' => 'Список договоров: установлен модуль shef.iblock с инфоблоком-списком договоров.',
			],
			[
				'key'  => 'company_requisite',
				'hint' => 'Реквизит компании RQ_INN (УНП поставщика) — стандартный для не-РФ стран.',
			],
		];
	}
}
