<?php
namespace Shef\Purchase\Controllers;

use Bitrix\Main\Engine;
use Bitrix\Main\Error;
use Shef\Options\TraitList;
use Shef\IBlock\Lists\Dogovor;

/**
 * Поиск договора закупки для procure-ai.
 * REST: shef.purchase.api.procurecontract.find
 *
 * Инфоблок-список IBLOCK_ID=32 (Shef\IBlock\Lists\Dogovor\Entity).
 * Фильтр: CLIENT=CO_<supplierId>, ACTIVE=Y, STATUS != TO_DELETE,
 *         TYPE in {PURCHASE, PURCHASE_ZAK}, опц. NUMBER (exact), DATE (exact day).
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

	public function configureActions()
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
	 * @param string $number     Номер договора из документа (опциональный, exact match)
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

		// Narrow by contract number if provided (exact match)
		if($number !== '')
		{
			$filter['=PROPERTY_'.$numberField->getPropertyId()] = $number;
		}

		// Narrow by date if provided (exact day equality, format d.m.Y)
		if($date !== '')
		{
			$filter['=PROPERTY_'.$dateField->getPropertyId()] = $date;
		}

		$rows = Dogovor\Entity::getList([
			'filter' => $filter,
			'order'  => ['ID' => 'ASC'],
			'limit'  => 1,
			'select' => [
				'ID',
				'PROPERTY_'.$numberField->getPropertyId(),
				'PROPERTY_'.$dateField->getPropertyId(),
			],
		]);

		if(empty($rows))
		{
			return ['id' => null];
		}

		$row = reset($rows);
		return [
			'id'     => (int)$row['ID'],
			'number' => (string)($row['PROPERTY_'.$numberField->getPropertyId().'_VALUE'] ?? ''),
			'date'   => (string)($row['PROPERTY_'.$dateField->getPropertyId().'_VALUE'] ?? ''),
		];
	}
}
