<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\Purchase\Controllers\ProcureSupplier;
use Shef\Purchase\Tests\Stub;
use Shef\Purchase\Tests\StubState;

/**
 * Поиск поставщика по УНП: guard-коды и нормализация «грязного» ввода (#102).
 */
final class ProcureSupplierTest extends TestCase
{
	protected function setUp(): void
	{
		Stub::reset();
	}

	public function testEmptyUnpReturnsSup010(): void
	{
		$c = new ProcureSupplier();
		$this->assertNull($c->findByUnpAction('   '));
		$this->assertSame(['sup:010'], $c->errorCodes());
	}

	public function testOverlongUnpReturnsSup011(): void
	{
		$c = new ProcureSupplier();
		$this->assertNull($c->findByUnpAction(str_repeat('1', 33)));
		$this->assertContains('sup:011', $c->errorCodes());
	}

	public function testNonNineDigitUnpReturnsIdNullWithoutError(): void
	{
		// Невалидный формат (прямой REST в обход Zod) → «не найдено» без кода ошибки.
		$c = new ProcureSupplier();
		$this->assertSame(['id' => null], $c->findByUnpAction('12345'));
		$this->assertSame([], $c->errorCodes());
	}

	public function testEightDigitUnpReturnsIdNullWithoutError(): void
	{
		// Граница: 8 цифр — не 9 → молчаливое «не найдено» (поиск не запускаем).
		$c = new ProcureSupplier();
		$this->assertSame(['id' => null], $c->findByUnpAction('12345678'));
		$this->assertSame([], $c->errorCodes());
		$this->assertSame([], \CCrmCompany::$calls); // до поиска не дошли
	}

	public function testTenDigitUnpReturnsIdNullWithoutError(): void
	{
		// Граница: 10 цифр — не 9 → молчаливое «не найдено».
		$c = new ProcureSupplier();
		$this->assertSame(['id' => null], $c->findByUnpAction('1234567890'));
		$this->assertSame([], $c->errorCodes());
		$this->assertSame([], \CCrmCompany::$calls);
	}

	public function testDirtyUnpIsNormalisedBeforeLookup(): void
	{
		// OCR «123 456-789» → нормализуется к «123456789» и уходит в фильтр RQ_INN.
		\CCrmCompany::$resultQueue[] = [
			['ID' => 42, 'TITLE' => 'ООО Ромашка'],
		];

		$c = new ProcureSupplier();
		$res = $c->findByUnpAction('123 456-789');

		$this->assertSame(42, $res['id']);
		$this->assertSame('ООО Ромашка', $res['title']);
		$this->assertSame('123456789', $res['unp']);

		// В фильтр ушёл именно очищенный 9-значный УНП.
		$filter = \CCrmCompany::$calls[0]['filter'];
		$this->assertSame('123456789', $filter['RQ'][0]['VALUE']);
		$this->assertSame('RQ_INN', $filter['RQ'][0]['FIELD_NAME']);
	}

	public function testSupplierNotFoundReturnsIdNull(): void
	{
		\CCrmCompany::$resultQueue[] = []; // курсор без строк
		$c = new ProcureSupplier();
		$this->assertSame(['id' => null], $c->findByUnpAction('123456789'));
	}

	public function testSingleMatchHasNoMultiFlag(): void
	{
		// Одна компания с УНП — берём её, без признака мультиматча (#195).
		\CCrmCompany::$resultQueue[] = [['ID' => 42, 'TITLE' => 'ООО Ромашка']];
		$c = new ProcureSupplier();
		$res = $c->findByUnpAction('123456789');
		$this->assertSame(42, $res['id']);
		$this->assertArrayNotHasKey('multi', $res);
	}

	public function testMultiMatchSetsMultiFlagAndPicksMinId(): void
	{
		// Несколько компаний с одним УНП → берём min(id)=42 (первая по ID ASC) + multi:true (#195).
		\CCrmCompany::$resultQueue[] = [
			['ID' => 42, 'TITLE' => 'ООО Ромашка'],
			['ID' => 77, 'TITLE' => 'ООО Ромашка-дубль'],
		];
		$c = new ProcureSupplier();
		$res = $c->findByUnpAction('123456789');
		$this->assertSame(42, $res['id']);
		$this->assertTrue($res['multi']);
	}

	public function testModuleFailureReturnsNullAndForwardsErrors(): void
	{
		StubState::$modulesOk = false;
		StubState::$moduleErrors = [new \Bitrix\Main\Error('crm недоступен', 'mod:err')];

		$c = new ProcureSupplier();
		$this->assertNull($c->findByUnpAction('123456789'));
		$this->assertContains('mod:err', $c->errorCodes());
	}
}
