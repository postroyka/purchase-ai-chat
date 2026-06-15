<?php
/**
 * Лёгкий стаб рантайма Bitrix для юнит-тестов procure*-контроллеров.
 *
 * Контроллеры наследуют Bitrix\Main\Engine\Controller, подмешивают трейт
 * Shef\Options\TraitList\Modules и зовут глобальные классы CRM/IBlock
 * (CCrmDeal, CIBlockElement, …), которых вне коробки нет. Здесь определены
 * МИНИМАЛЬНЫЕ заглушки ровно того API, что реально используется в
 * lib/controllers/procure*.php и lib/config.php — не более.
 *
 * Поведение заглушек управляется через статические поля (очереди результатов,
 * коды возврата); эти статические поля сбрасываются между тестами через
 * Shef\Purchase\Tests\Stub::reset() (в setUp() каждого теста).
 *
 * ВАЖНО (регрессия by-ref, #99): сигнатуры CCrmDeal::Update() и
 * CommentController::onCreate() объявлены со ВТОРЫМ параметром ПО ССЫЛКЕ
 * (array &$fields) — как в реальном Bitrix. Если кто-то вернёт в контроллер
 * передачу литерала массива (а не переменной), на PHP 8 это Fatal Error
 * «Argument #N could not be passed by reference» (ровно тот баг, что чинили), и
 * PHPUnit зафиксирует его как ERROR теста.
 */

// ---------------------------------------------------------------------------
// Bitrix\Main — Error / Result
// ---------------------------------------------------------------------------
namespace Bitrix\Main {
	class Error
	{
		private string $message;
		private $code;

		public function __construct(string $message, $code = 0, $customData = null)
		{
			$this->message = $message;
			$this->code = $code;
		}

		public function getMessage(): string { return $this->message; }
		public function getCode() { return $this->code; }
	}

	/**
	 * Упрощённый аналог Bitrix\Main\Result: контроллерам нужны только
	 * isSuccess() и getErrors() (результат includeModules()).
	 */
	class Result
	{
		private bool $success;
		private array $errors;

		public function __construct(bool $success = true, array $errors = [])
		{
			$this->success = $success;
			$this->errors = $errors;
		}

		public function isSuccess(): bool { return $this->success; }
		public function getErrors(): array { return $this->errors; }
	}
}

// ---------------------------------------------------------------------------
// Bitrix\Main\Engine\Controller — база контроллеров (перехват ошибок)
// ---------------------------------------------------------------------------
namespace Bitrix\Main\Engine {
	class Controller
	{
		/** @var \Bitrix\Main\Error[] перехваченные addError()/addErrors() */
		public array $capturedErrors = [];

		public function __construct($request = null) {}

		public function addError(\Bitrix\Main\Error $error): void
		{
			$this->capturedErrors[] = $error;
		}

		public function addErrors(array $errors): void
		{
			foreach ($errors as $error)
			{
				$this->capturedErrors[] = $error;
			}
		}

		public static function getDefaultPreFilters(): array { return []; }

		/** Тест-хелпер: коды всех перехваченных ошибок (в порядке добавления). */
		public function errorCodes(): array
		{
			return array_map(
				static fn (\Bitrix\Main\Error $e) => $e->getCode(),
				$this->capturedErrors
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Bitrix\Main\Config\Option — настройки модуля (отдаём дефолты/подменённые)
// ---------------------------------------------------------------------------
namespace Bitrix\Main\Config {
	class Option
	{
		/** Подменённые значения, ключ "<module>/<name>". Пусто → возвращаем $default. */
		public static array $values = [];

		public static function get($module, $name, $default = false, $siteId = false)
		{
			return self::$values["$module/$name"] ?? $default;
		}
	}
}

// ---------------------------------------------------------------------------
// Shef\Options\TraitList\Modules — трейт includeModules()
// ---------------------------------------------------------------------------
namespace Shef\Options\TraitList {
	trait Modules
	{
		public function includeModules(): \Bitrix\Main\Result
		{
			return new \Bitrix\Main\Result(
				\Shef\Purchase\Tests\StubState::$modulesOk,
				\Shef\Purchase\Tests\StubState::$moduleErrors
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Управление состоянием заглушек + сброс между тестами
// ---------------------------------------------------------------------------
namespace Shef\Purchase\Tests {
	/** Флаги includeModules() (можно ронять модульную загрузку в тесте). */
	class StubState
	{
		public static bool $modulesOk = true;
		/** @var \Bitrix\Main\Error[] */
		public static array $moduleErrors = [];

		public static function reset(): void
		{
			self::$modulesOk = true;
			self::$moduleErrors = [];
		}
	}

	/** Единая точка сброса всех заглушек — вызывать в setUp() каждого теста. */
	class Stub
	{
		public static function reset(): void
		{
			StubState::reset();

			\CCrmCompany::$calls = [];
			\CCrmCompany::$resultQueue = [];

			\CIBlockElement::$calls = [];
			\CIBlockElement::$resultQueue = [];

			\CUserTypeEntity::$added = [];
			\CUserTypeEntity::$existing = [];
			\CUserTypeEntity::$addReturn = 50;

			\CCrmDeal::$addReturn = 100;
			\CCrmDeal::$lastAddFields = null;
			\CCrmDeal::$saveRowsReturn = true;
			\CCrmDeal::$lastProductRows = null;
			\CCrmDeal::$updateReturn = true;
			\CCrmDeal::$lastUpdateFields = null;

			\CRestUtil::$saveFileReturn = ['ID' => 1, 'name' => 'stub'];
			\CRestUtil::$lastArg = null;

			\Bitrix\Crm\Timeline\CommentEntry::$createReturn = 555;
			\Bitrix\Crm\Timeline\CommentEntry::$lastCreate = null;
			\Bitrix\Crm\Timeline\CommentEntry::$throwOnCreate = false;
			\Bitrix\Crm\Timeline\CommentController::$lastOnCreate = null;
			\Bitrix\Crm\Timeline\CommentController::$instance = null;

			\Shef\IBlock\Lists\Dogovor\Entity::$rows = [];
			\Shef\IBlock\Lists\Dogovor\Entity::$lastGetListArgs = null;
			\Shef\IBlock\Lists\Dogovor\Entity::$instance = null;

			\Bitrix\Main\Config\Option::$values = [];
		}
	}
}

// ---------------------------------------------------------------------------
// Bitrix\Crm\Timeline — CommentEntry / CommentController
// ---------------------------------------------------------------------------
namespace Bitrix\Crm\Timeline {
	class CommentEntry
	{
		public static $createReturn = 555;
		public static ?array $lastCreate = null;
		/** true → create() бросает \Throwable (для проверки timeline_comment_failed). */
		public static bool $throwOnCreate = false;

		public static function create(array $fields)
		{
			self::$lastCreate = $fields;
			if (self::$throwOnCreate)
			{
				throw new \RuntimeException('timeline create failed (stub)');
			}
			return self::$createReturn;
		}
	}

	class CommentController
	{
		public static ?CommentController $instance = null;
		public static ?array $lastOnCreate = null;

		public static function getInstance(): self
		{
			return self::$instance ??= new self();
		}

		/** ВТОРОЙ ПАРАМЕТР ПО ССЫЛКЕ — как в реальном Bitrix (регрессия #99). */
		public function onCreate($id, array &$fields): void
		{
			self::$lastOnCreate = $fields;
		}
	}
}

// ---------------------------------------------------------------------------
// Shef\IBlock\Lists\Dogovor — сущность инфоблока-списка договоров.
// Стабим РОВНО тот API, что вызывает procurecontract.php (getInstance/getField/
// getList) — не угадываем, а отражаем реальные вызовы. Содержимое фильтра нам
// безразлично: getList() отдаёт заранее заданные строки (Entity::$rows).
// ---------------------------------------------------------------------------
namespace Shef\IBlock\Lists\Dogovor {
	class Entity
	{
		public static ?Entity $instance = null;
		/** @var array<int,array> строки, которые вернёт getList() */
		public static array $rows = [];
		public static ?array $lastGetListArgs = null;

		public static function getInstance(): self
		{
			return self::$instance ??= new self();
		}

		public function getField(string $name): \Shef\IBlock\Lists\Dogovor\FieldStub
		{
			return new FieldStub($name);
		}

		public static function getList(array $params): array
		{
			self::$lastGetListArgs = $params;
			return self::$rows;
		}
	}

	/**
	 * Заглушка поля инфоблока. getPropertyId() даёт стабильные id, чтобы ключи
	 * строк PROPERTY_<id>_VALUE в тестах были предсказуемы (NUMBER=100, DATE=200).
	 */
	class FieldStub
	{
		public function __construct(private string $name) {}

		public function getPropertyId(): int
		{
			return match ($this->name)
			{
				'NUMBER' => 100,
				'DATE'   => 200,
				'CLIENT' => 300,
				'STATUS' => 400,
				'TYPE'   => 500,
				default  => 999,
			};
		}

		public function getStatusToDelete(): string { return 'TO_DELETE'; }
		public function getStatusPurchase(): string { return 'PURCHASE'; }
		public function getStatusPurchaseZak(): string { return 'PURCHASE_ZAK'; }
	}
}

// ---------------------------------------------------------------------------
// Глобальные классы/функции Bitrix (CRM, IBlock, REST, дата)
// ---------------------------------------------------------------------------
namespace {
	/** Эмуляция курсора GetList/GetListEx: Fetch() отдаёт строки по очереди. */
	class FakeDbResult
	{
		private array $rows;

		public function __construct(array $rows) { $this->rows = $rows; }

		public function Fetch()
		{
			if (!$this->rows)
			{
				return false;
			}
			return array_shift($this->rows);
		}
	}

	class CCrmCompany
	{
		/** @var array<int,array> аргументы каждого вызова GetListEx */
		public static array $calls = [];
		/** @var array<int,array> очередь наборов строк; каждый вызов берёт один набор */
		public static array $resultQueue = [];

		public static function GetListEx($order, $filter, $g = false, $nav = false, $select = [])
		{
			self::$calls[] = ['order' => $order, 'filter' => $filter, 'nav' => $nav, 'select' => $select];
			$rows = array_shift(self::$resultQueue);
			return new \FakeDbResult($rows ?? []);
		}
	}

	class CIBlockElement
	{
		public static array $calls = [];
		public static array $resultQueue = [];

		public static function GetList($order, $filter, $groupBy = false, $nav = false, $select = [])
		{
			self::$calls[] = ['order' => $order, 'filter' => $filter, 'nav' => $nav, 'select' => $select];
			$rows = array_shift(self::$resultQueue);
			return new \FakeDbResult($rows ?? []);
		}
	}

	/**
	 * Заглушка CUserTypeEntity (пользовательские поля). GetList() «находит» поле, если его
	 * FIELD_NAME перечислен в $existing; Add() складывает поля в $added и возвращает
	 * $addReturn (id > 0 — успех, false — провал создания).
	 */
	class CUserTypeEntity
	{
		/** @var array<int,array> поля, переданные в Add() */
		public static array $added = [];
		/** Коды (FIELD_NAME) уже существующих полей — их «находит» GetList(). */
		public static array $existing = [];
		/** Что вернёт Add(): id (>0 успех) или false (провал). */
		public static $addReturn = 50;

		public function Add(array $fields)
		{
			self::$added[] = $fields;
			return self::$addReturn;
		}

		public static function GetList($order = [], $filter = [])
		{
			$name = $filter['FIELD_NAME'] ?? null;
			$rows = in_array($name, self::$existing, true) ? [['FIELD_NAME' => $name]] : [];
			return new \FakeDbResult($rows);
		}
	}

	class CCrmDeal
	{
		public $LAST_ERROR = '';

		/** dealId при успехе или false при провале Add(). */
		public static $addReturn = 100;
		public static ?array $lastAddFields = null;
		public static bool $saveRowsReturn = true;
		public static ?array $lastProductRows = null;
		public static bool $updateReturn = true;
		public static ?array $lastUpdateFields = null;

		public function __construct($check = true) {}

		public function Add(array $fields, $bUpdateSearch = true, $options = [])
		{
			self::$lastAddFields = $fields;
			return self::$addReturn;
		}

		public static function SaveProductRows($dealId, array $rows, $checkPerms = true, $regEvent = true)
		{
			self::$lastProductRows = $rows;
			return self::$saveRowsReturn;
		}

		/** ВТОРОЙ ПАРАМЕТР ПО ССЫЛКЕ — как в реальном Bitrix (регрессия #99). */
		public function Update($id, array &$fields, $bCompare = true)
		{
			self::$lastUpdateFields = $fields;
			return self::$updateReturn;
		}
	}

	class CRestUtil
	{
		/** Результат saveFile(): массив (успех) или false. */
		public static $saveFileReturn = ['ID' => 1, 'name' => 'stub'];
		public static $lastArg = null;

		public static function saveFile($arg)
		{
			self::$lastArg = $arg;
			return self::$saveFileReturn;
		}
	}

	class CCrmOwnerType
	{
		const Deal = 2;
	}

	if (!function_exists('ConvertTimeStamp'))
	{
		function ConvertTimeStamp($timestamp = false, $type = 'SHORT', $site = false)
		{
			$timestamp = $timestamp ?: time();
			// Реальный Bitrix: 'FULL' → d.m.Y H:i:s, 'SHORT' → d.m.Y.
			return $type === 'FULL'
				? date('d.m.Y H:i:s', $timestamp)
				: date('d.m.Y', $timestamp);
		}
	}
}
