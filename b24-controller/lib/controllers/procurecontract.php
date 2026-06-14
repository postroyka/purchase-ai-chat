<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Shef\Options\TraitList;
use Shef\IBlock\Lists\Dogovor;
use Shef\Purchase\Config;

/**
 * Поиск договора закупки для procure-ai.
 * REST: shef:purchase.api.procurecontract.find
 *
 * Инфоблок-список IBLOCK_ID=32 (Shef\IBlock\Lists\Dogovor\Entity).
 * Фильтр: CLIENT=CO_<supplierId>, ACTIVE=Y, STATUS != TO_DELETE,
 *         TYPE in {PURCHASE, PURCHASE_ZAK}. Опц. сужение по NUMBER и DATE
 *         сверяется в PHP: номер — устойчиво к латинице/кириллице (гомоглифы),
 *         дата — по отображаемому d.m.Y.
 * При нескольких совпадениях возвращается запись с минимальным ID.
 */
class ProcureContract
	extends Engine\Controller
{
	use TraitList\Modules;

	protected static function getModulesList(): array
	{
		return [
			'iblock',
			'crm',
			'shef.iblock',
		];
	}

	public function configureActions(): array
	{
		return [
			'find' => [
				'prefilters' => parent::getDefaultPreFilters(),
			],
		];
	}

	/**
	 * Ищет договор закупки по компании-поставщику.
	 *
	 * @param int    $supplierId ID компании (CLIENT = CO_<id>)
	 * @param string $number     Номер договора из документа (опц.); совпадение
	 *                           устойчиво к латинице/кириллице (напр. 243Э20)
	 * @param string $date       Дата договора из документа, формат d.m.Y (опциональный)
	 * @return array|null { id, number, date } | { id: null } при не найдено
	 */
	public function findAction(
		int $supplierId,
		string $number = '',
		string $date = ''
	): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		if($supplierId < 1)
		{
			$this->addError(new Error('Invalid supplierId', 'con:010'));
			return null;
		}

		// Симметрично prd:011 / sup:011 — отсекаем заведомо мусорный длинный номер
		// договора (защита перед перебором + согласованность контракта, #102).
		if(mb_strlen($number) > 64)
		{
			$this->addError(new Error('Слишком длинный номер договора', 'con:011'));
			return null;
		}

		$entity = Dogovor\Entity::getInstance();

		/** @var \Shef\IBlock\Lists\Dogovor\Fields\IBlock\Status $statusField */
		$statusField = $entity->getField('STATUS');
		/** @var \Shef\IBlock\Lists\Dogovor\Fields\IBlock\Type $typeField */
		$typeField = $entity->getField('TYPE');
		/** @var \Shef\IBlock\Lists\Base\Fields\IBlock\AField $numberField */
		$numberField = $entity->getField('NUMBER');
		/** @var \Shef\IBlock\Lists\Base\Fields\IBlock\AField $dateField */
		$dateField = $entity->getField('DATE');
		/** @var \Shef\IBlock\Lists\Base\Fields\IBlock\AField $clientField */
		$clientField = $entity->getField('CLIENT');

		$filter = [
			// Только активные элементы инфоблока. ВАЖНО: Dogovor\Entity::getList
			// внутри вызывает getListInner(isActive=false), который добавляет
			// SHOW_NEW=Y, а НЕ ACTIVE=Y — поэтому фильтр по ACTIVE ставим явно.
			'ACTIVE' => 'Y',
			// CLIENT is stored as CO_<id> for companies (confirmed B3a)
			'PROPERTY_'.$clientField->getPropertyId() => 'CO_'.$supplierId,
			// STATUS != TO_DELETE (брак) — exclude all broken contracts
			'!PROPERTY_'.$statusField->getPropertyId() => $statusField->getStatusToDelete(),
			// TYPE in {PURCHASE, PURCHASE_ZAK}
			'PROPERTY_'.$typeField->getPropertyId() => [
				$typeField->getStatusPurchase(),
				$typeField->getStatusPurchaseZak(),
			],
		];

		// Номер и дату НЕ кладём в SQL-фильтр, а сверяем в PHP:
		//  - номер: устойчиво к латинице/кириллице (243Э20 ↔ 243Э20) через
		//    Config::foldHomoglyphs — точное =PROPERTY на уровне БД молча ломалось бы;
		//  - дата: сравниваем отображаемое значение (d.m.Y), не завися от внутреннего
		//    формата хранения свойства.
		// Договоров у поставщика немного → выбираем кандидатов и фильтруем здесь.
		$numProp  = 'PROPERTY_'.$numberField->getPropertyId();
		$dateProp = 'PROPERTY_'.$dateField->getPropertyId();

		$rows = Dogovor\Entity::getList([
			'filter' => $filter,
			'order'  => ['ID' => 'ASC'],
			'select' => ['ID', $numProp, $dateProp],
		]);

		$wantNumber = $number !== '' ? Config::foldHomoglyphs($number) : '';
		$wantDate   = trim($date);

		foreach($rows as $row)
		{
			$rowNumber = (string)($row[$numProp.'_VALUE'] ?? '');
			$rowDate   = (string)($row[$dateProp.'_VALUE'] ?? '');

			if($wantNumber !== '' && Config::foldHomoglyphs($rowNumber) !== $wantNumber)
			{
				continue;
			}
			if($wantDate !== '' && trim($rowDate) !== $wantDate)
			{
				continue;
			}

			// order ID ASC + первый подошедший = минимальный ID.
			return [
				'id'     => (int)$row['ID'],
				'number' => $rowNumber,
				'date'   => $rowDate,
			];
		}

		return ['id' => null];
	}
}
