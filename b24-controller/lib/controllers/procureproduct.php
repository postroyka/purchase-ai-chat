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
			'findByVendorCodes' => [
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
			['nTopCount' => 2],              // #195: до 2 — заметить мультиматч (>1 товар на артикул)
			['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
		);
		$rows = [];
		if(is_object($exact))
		{
			while(count($rows) < 2 && ($row = $exact->Fetch()))
			{
				$rows[] = $row;
			}
		}
		if($rows)
		{
			$out = self::formatProduct($rows[0]);
			if(count($rows) >= 2)
			{
				$out['multi'] = true; // #195: артикул совпал с >1 товаром — молча взяли min(id)
			}
			return $out;
		}

		// Точного совпадения нет → товар не найден. Подмену раскладки/гомоглифов и
		// LIKE-фолбэк убрали намеренно: артикул сверяется строго «как есть». Несопоставленную
		// позицию агент в сделку не кладёт, а пишет в лог (см. prompts/main.md, Шаг 4).
		return ['id' => null];
	}

	/**
	 * Батч-поиск активных родительских товаров по СПИСКУ артикулов (#262, рычаг №1).
	 *
	 * Один IN-запрос (`=PROPERTY_PURCHASE_ARTICLE => [коды]`) вместо N точечных
	 * round-trip'ов `findByVendorCode` — замеры показали, что «медленно» делает число
	 * сетевых round-trip'ов, а не вычисление портала. Семантика совпадения та же, что у
	 * одиночного метода: СТРОГО точное сравнение артикула «как есть» (без фолдинга
	 * раскладки/гомоглифов), при дублях — товар с минимальным ID + флаг `multi` (#195).
	 *
	 * Возвращает СПИСОК результатов для КАЖДОГО запрошенного артикула (в порядке
	 * запроса): `{ id, name, vendorCode[, multi] }` если найден, иначе
	 * `{ vendorCode, id: null }`. Каждый элемент самоописателен (несёт свой
	 * `vendorCode`), потребитель сопоставляет по полю — НЕ карта с ключом-артикулом
	 * (в PHP числовые строки-артикулы вроде "654441" превратились бы в int-ключи и
	 * могли бы сериализоваться как массив, а не объект). Пустые элементы списка
	 * отбрасываются; дубликаты схлопываются.
	 *
	 * @param string[] $vendorCodes Артикулы поставщика из документа
	 * @return array<int,array>|null Список результатов | null при guard-ошибке
	 */
	public function findByVendorCodesAction(array $vendorCodes): ?array
	{
		$response = $this->includeModules();
		if(!$response->isSuccess())
		{
			$this->addErrors($response->getErrors());
			return null;
		}

		// Нормализация + валидация. Каждый элемент: строка, trim, непустой, ≤64 символов.
		// Дубликаты схлопываем (ключ массива), порядок первого вхождения сохраняем.
		$codes = [];
		foreach($vendorCodes as $vc)
		{
			if(!is_string($vc))
			{
				$this->addError(new Error('Артикул должен быть строкой', 'prd:012'));
				return null;
			}
			$vc = trim($vc);
			if($vc === '')
			{
				continue; // пустые молча отбрасываем — не повод валить весь батч
			}
			if(mb_strlen($vc) > 64)
			{
				$this->addError(new Error('Слишком длинный артикул', 'prd:011'));
				return null;
			}
			$codes[$vc] = true;
		}
		$codes = array_keys($codes);

		if(!$codes)
		{
			$this->addError(new Error('Пустой список артикулов', 'prd:013'));
			return null;
		}
		// Bitrix REST-batch ограничен 50 командами; держим тот же потолок и для IN-выборки,
		// чтобы не упереться в лимиты при гигантском документе. Агент бьёт список на пачки ≤50.
		if(count($codes) > 50)
		{
			$this->addError(new Error('Слишком много артикулов за раз (макс 50)', 'prd:014'));
			return null;
		}

		$iblockId = Config::getCatalogIblockId();

		// Один IN-запрос по всем артикулам сразу (массив в =PROPERTY = условие IN).
		// Сортировка по ID ASC: первое вхождение каждого артикула = минимальный ID.
		$res = \CIBlockElement::GetList(
			['ID' => 'ASC'],
			[
				'=PROPERTY_PURCHASE_ARTICLE'           => $codes,
				'IBLOCK_ID'                            => $iblockId,
				'ACTIVE'                               => 'Y',
				'=PROPERTY_PURCHASE_69_PARENT_PRODUCT' => false,
			],
			false,
			false,
			['ID', 'NAME', 'PROPERTY_PURCHASE_ARTICLE']
		);

		// Группируем строки по артикулу: первая (min ID при ASC) → результат, >1 → multi.
		$byArticle = [];
		if(is_object($res))
		{
			while($row = $res->Fetch())
			{
				$art = (string)$row['PROPERTY_PURCHASE_ARTICLE_VALUE'];
				if(!isset($byArticle[$art]))
				{
					$byArticle[$art] = self::formatProduct($row);
				}
				else
				{
					$byArticle[$art]['multi'] = true; // #195: >1 товар на артикул
				}
			}
		}

		// Список по КАЖДОМУ запрошенному артикулу (в порядке запроса; не найденные →
		// {vendorCode, id:null}). Ключ `$vc` из array_keys может быть int (PHP кастит
		// числовые строки-ключи), поэтому в ответ артикул кладём как (string) и берём
		// список, а не карту — чтобы "654441" не стало числом/индексом массива.
		$out = [];
		foreach($codes as $vc)
		{
			$out[] = $byArticle[$vc] ?? ['vendorCode' => (string)$vc, 'id' => null];
		}

		return $out;
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
