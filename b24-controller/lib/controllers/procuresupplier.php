<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Shef\Options\TraitList;

/**
 * Поиск поставщика по УНП для procure-ai.
 * REST: shef:purchase.api.procuresupplier.findByUnp
 */
class ProcureSupplier
	extends Engine\Controller
{
	use TraitList\Modules;

	protected static function getModulesList(): array
	{
		return [
			'crm',
		];
	}

	public function configureActions(): array
	{
		return [
			'findByUnp' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * Ищет компанию-поставщика по УНП (реквизит RQ_INN).
	 * Точное совпадение; при дублях — компания с минимальным ID.
	 *
	 * @param string $unp УНП поставщика из документа
	 * @return array|null { id, title, unp } | { id: null }
	 */
	public function findByUnpAction(string $unp): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		$unp = trim($unp);
		// Нормализация «грязного» ввода от OCR: убираем пробелы и дефисы (УНП РБ —
		// 9 цифр подряд). Согласовано с MCP-инструментом find-supplier (#102), где
		// та же нормализация выполняется перед валидацией.
		$unp = (string)preg_replace('/[\s\x{A0}\-]+/u', '', $unp);
		if($unp === '')
		{
			$this->addError(new Error('Пустой УНП', 'sup:010'));
			return null;
		}

		// УНП РБ — 9 цифр. Не валим на точном формате (вдруг придёт с пробелами/
		// дефисами от OCR), но отсекаем заведомо мусорные длинные значения.
		if(mb_strlen($unp) > 32)
		{
			$this->addError(new Error('Слишком длинный УНП', 'sup:011'));
			return null;
		}

		// После нормализации УНП РБ — ровно 9 цифр. Невалидный формат (прямой
		// REST-вызов в обход MCP, где Zod уже это гарантирует) → не ищем,
		// возвращаем «не найдено» без отдельного кода ошибки (#113).
		if(!preg_match('/^\d{9}$/', $unp))
		{
			return ['id' => null];
		}

		// Страна реквизита (4 = Беларусь по умолчанию).
		$countryId = (int)\Bitrix\Main\Config\Option::get(
			'crm',
			'crm_requisite_preset_country_id',
			4
		);

		// Поиск по реквизиту: CCrmCompany::GetListEx поддерживает спец-ключ 'RQ'
		// (фильтр по реквизитам компании) — проверено на рабочей коробке.
		$filter = [
			'RQ' => [
				[
					'COUNTRY_ID' => $countryId,
					'FIELD_NAME' => 'RQ_INN',
					'OPERATION'  => '=',   // точное совпадение (бизнес-правило)
					'VALUE'      => $unp,
				],
			],
		];

		$dbResult = \CCrmCompany::GetListEx(
			['ID' => 'ASC'],            // мин. ID при дублях
			$filter,
			false,
			['nTopCount' => 1],
			['ID', 'TITLE']
		);

		if(is_object($dbResult) && ($fields = $dbResult->Fetch()))
		{
			return [
				'id'    => (int)$fields['ID'],
				'title' => (string)$fields['TITLE'],
				'unp'   => $unp,
			];
		}

		// Не найдено — не ошибка, агент решит по бизнес-правилам.
		return ['id' => null];
	}
}
