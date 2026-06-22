<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\IBlock\Lists\Dogovor\Entity as DogovorEntity;
use Shef\Purchase\Controllers\ProcureContract;
use Shef\Purchase\Tests\Stub;
use Shef\Purchase\Tests\StubState;

/**
 * Поиск договора: guard-коды (con:010/con:011) и PHP-фильтрация выборки по
 * номеру (устойчиво к раскладке) и дате (точное d.m.Y), выбор минимального ID.
 *
 * Сущность инфоблока Dogovor\Entity замокана (см. tests/stubs/bitrix.php):
 * getList() отдаёт заданные строки, фильтрацию выполняет сам контроллер.
 * Ключи строк: PROPERTY_100_VALUE = номер, PROPERTY_200_VALUE = дата.
 */
final class ProcureContractTest extends TestCase
{
	protected function setUp(): void
	{
		Stub::reset();
	}

	private function row(int $id, string $number, string $date): array
	{
		return ['ID' => $id, 'PROPERTY_100_VALUE' => $number, 'PROPERTY_200_VALUE' => $date];
	}

	public function testInvalidSupplierIdReturnsCon010(): void
	{
		$c = new ProcureContract();
		$this->assertNull($c->findAction(0));
		$this->assertSame(['con:010'], $c->errorCodes());
	}

	public function testOverlongNumberReturnsCon011(): void
	{
		// Симметрично prd:011 / sup:011 (#102).
		$c = new ProcureContract();
		$this->assertNull($c->findAction(5, str_repeat('Z', 65)));
		$this->assertContains('con:011', $c->errorCodes());
	}

	public function testNumberAtLimitPassesGuard(): void
	{
		// Ровно 64 символа — граница «> 64» не срабатывает; выборка пуста → id:null.
		$c = new ProcureContract();
		$this->assertSame(['id' => null], $c->findAction(5, str_repeat('Z', 64)));
		$this->assertNotContains('con:011', $c->errorCodes());
	}

	public function testNoNumberOrDateReturnsFirstByMinId(): void
	{
		DogovorEntity::$rows = [
			$this->row(10, 'A1', '01.01.2020'),
			$this->row(20, 'B2', '02.02.2020'),
		];
		$c = new ProcureContract();
		$res = $c->findAction(5);
		$this->assertSame(10, $res['id']); // первый (order ID ASC) = минимальный

		// Стаб getList() игнорирует $params — поэтому отдельно проверяем, что сам
		// контроллер собрал правильный SQL-фильтр (иначе сдвиг фильтрации на БД
		// остался бы незамеченным, #99 ревью). CLIENT=300, ACTIVE, TYPE=500.
		$filter = DogovorEntity::$lastGetListArgs['filter'];
		$this->assertSame('CO_5', $filter['PROPERTY_300']);
		$this->assertSame('Y', $filter['ACTIVE']);
		$this->assertArrayHasKey('PROPERTY_500', $filter); // фильтр по TYPE присутствует
	}

	public function testMultiMatchSetsMultiFlagAndPicksMinId(): void
	{
		// Несколько договоров подходят (без фильтра номера/даты) → min(id)=10 + multi:true (#195).
		DogovorEntity::$rows = [
			$this->row(10, 'A1', '01.01.2020'),
			$this->row(20, 'B2', '02.02.2020'),
		];
		$c = new ProcureContract();
		$res = $c->findAction(5);
		$this->assertSame(10, $res['id']);
		$this->assertTrue($res['multi']);
	}

	public function testSingleMatchHasNoMultiFlag(): void
	{
		DogovorEntity::$rows = [$this->row(10, 'A1', '01.01.2020')];
		$c = new ProcureContract();
		$res = $c->findAction(5);
		$this->assertArrayNotHasKey('multi', $res);
	}

	public function testNumberMatchIsHomoglyphTolerant(): void
	{
		// В базе номер латиницей «ABC», в документе кириллицей «АВС» → должны совпасть.
		DogovorEntity::$rows = [$this->row(10, 'ABC', '01.01.2020')];
		$c = new ProcureContract();
		$res = $c->findAction(5, 'АВС');
		$this->assertSame(10, $res['id']);
		$this->assertSame('ABC', $res['number']);
	}

	public function testNumberMatchIgnoresParentheticalSuffix(): void
	{
		// В Б24 к номеру дописывают аннотацию «(основной)», в документе номер чистый →
		// должны совпасть. Возвращаем номер как в Б24 (с припиской).
		DogovorEntity::$rows = [$this->row(10, '789-22/24 (основной)', '04.03.2024')];
		$c = new ProcureContract();
		$res = $c->findAction(5, '789-22/24');
		$this->assertSame(10, $res['id']);
		$this->assertSame('789-22/24 (основной)', $res['number']);
	}

	public function testNumberMatchStripsMultipleSpacedSuffixes(): void
	{
		// Несколько хвостовых скобок подряд (через пробел) — срезаются все.
		DogovorEntity::$rows = [$this->row(11, '789-22/24 (доп.) (основной)', '01.01.2020')];
		$c = new ProcureContract();
		$this->assertSame(11, $c->findAction(5, '789-22/24')['id']);
	}

	public function testNumberMatchKeepsParenthesisInBody(): void
	{
		// Скобка В ТЕЛЕ номера (не на хвосте) НЕ срезается ($-якорь): «789-(22)/24».
		DogovorEntity::$rows = [$this->row(12, '789-(22)/24', '01.01.2020')];
		$c = new ProcureContract();
		$this->assertSame(12, $c->findAction(5, '789-(22)/24')['id']);
	}

	public function testNumberSuffixWithoutSpaceNotStripped(): void
	{
		// Хвостовая скобка БЕЗ пробела — часть номера, а не аннотация: «ТМ-100(А)» НЕ
		// срезается (\s+), поэтому чистый «ТМ-100» с ним НЕ совпадает (защита от ложного матча).
		DogovorEntity::$rows = [$this->row(13, 'ТМ-100(А)', '01.01.2020')];
		$c = new ProcureContract();
		$this->assertSame(['id' => null], $c->findAction(5, 'ТМ-100'));
	}

	public function testDateNarrowsToCorrectContract(): void
	{
		DogovorEntity::$rows = [
			$this->row(10, 'X', '15.03.2025'),
			$this->row(11, 'X', '16.03.2025'),
		];
		$c = new ProcureContract();
		$res = $c->findAction(5, 'X', '16.03.2025');
		$this->assertSame(11, $res['id']);
		$this->assertSame('16.03.2025', $res['date']);
	}

	public function testNoMatchReturnsIdNull(): void
	{
		DogovorEntity::$rows = [$this->row(10, 'A', '01.01.2020')];
		$c = new ProcureContract();
		$this->assertSame(['id' => null], $c->findAction(5, 'B'));
	}

	public function testModuleFailureReturnsNull(): void
	{
		StubState::$modulesOk = false;
		$c = new ProcureContract();
		$this->assertNull($c->findAction(5));
	}
}
