<?php
declare(strict_types=1);

namespace Shef\Purchase\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Shef\Purchase\Controllers\ProcureInstall;
use Shef\Purchase\Tests\Stub;
use Shef\Purchase\Tests\StubState;

/**
 * Самонастройка схемы (ensureSchema): идемпотентное создание кастомных полей сделки
 * + чек-лист предусловий. Bitrix-рантайм замокан (tests/stubs/bitrix.php).
 */
final class ProcureInstallTest extends TestCase
{
	private const FILE_UF = 'UF_CRM_DEAL_SH_PRCHS_AI_FILE';
	private const DOGOVOR_UF = 'UF_CRM_DEAL_DOGOVOR';

	protected function setUp(): void
	{
		Stub::reset();
	}

	public function testCreatesMissingDealUserFields(): void
	{
		\CUserTypeEntity::$existing = []; // на коробке полей нет

		$c = new ProcureInstall();
		$r = $c->ensureSchemaAction();

		$this->assertTrue($r['ok']);
		$this->assertEqualsCanonicalizing([self::FILE_UF, self::DOGOVOR_UF], $r['created']);
		$this->assertSame([], $r['existing']);
		$this->assertSame([], $r['failed']);

		// Реально дёрнули Add() на оба поля с правильными типами/сущностью.
		$this->assertCount(2, \CUserTypeEntity::$added);
		$byName = [];
		foreach(\CUserTypeEntity::$added as $f)
		{
			$byName[$f['FIELD_NAME']] = $f;
		}
		$this->assertSame('file', $byName[self::FILE_UF]['USER_TYPE_ID']);
		$this->assertSame('string', $byName[self::DOGOVOR_UF]['USER_TYPE_ID']);
		$this->assertSame('CRM_DEAL', $byName[self::FILE_UF]['ENTITY_ID']);
		$this->assertSame('CRM_DEAL', $byName[self::DOGOVOR_UF]['ENTITY_ID']);
	}

	public function testIdempotentWhenAllFieldsExist(): void
	{
		\CUserTypeEntity::$existing = [self::FILE_UF, self::DOGOVOR_UF];

		$c = new ProcureInstall();
		$r = $c->ensureSchemaAction();

		$this->assertTrue($r['ok']);
		$this->assertSame([], $r['created']);
		$this->assertEqualsCanonicalizing([self::FILE_UF, self::DOGOVOR_UF], $r['existing']);
		$this->assertSame([], \CUserTypeEntity::$added, 'при существующих полях Add() не вызывается');
	}

	public function testPartiallyExistingCreatesOnlyMissing(): void
	{
		\CUserTypeEntity::$existing = [self::DOGOVOR_UF]; // договор уже есть

		$c = new ProcureInstall();
		$r = $c->ensureSchemaAction();

		$this->assertTrue($r['ok']);
		$this->assertSame([self::FILE_UF], $r['created']);
		$this->assertSame([self::DOGOVOR_UF], $r['existing']);
		$this->assertCount(1, \CUserTypeEntity::$added);
		$this->assertSame(self::FILE_UF, \CUserTypeEntity::$added[0]['FIELD_NAME']);
	}

	public function testAddFailureIsReportedAndNotOk(): void
	{
		\CUserTypeEntity::$existing = [];
		\CUserTypeEntity::$addReturn = false; // Add() не создал поле

		$c = new ProcureInstall();
		$r = $c->ensureSchemaAction();

		$this->assertFalse($r['ok']);
		$this->assertSame([], $r['created']);
		$this->assertEqualsCanonicalizing([self::FILE_UF, self::DOGOVOR_UF], $r['failed']);
	}

	public function testChecklistEnumeratesPrerequisites(): void
	{
		$c = new ProcureInstall();
		$r = $c->ensureSchemaAction();

		$keys = array_column($r['checklist'], 'key');
		$this->assertEqualsCanonicalizing(
			['catalog_iblock', 'deal_pipeline', 'contract_list', 'company_requisite'],
			$keys
		);
		// Каждый пункт несёт человекочитаемую подсказку.
		foreach($r['checklist'] as $item)
		{
			$this->assertNotSame('', trim((string)$item['hint']));
		}
	}

	public function testModuleLoadFailureReturnsNullAndForwardsErrors(): void
	{
		StubState::$modulesOk = false;
		StubState::$moduleErrors = [new \Bitrix\Main\Error('crm недоступен', 'mod:err')];

		$c = new ProcureInstall();
		$this->assertNull($c->ensureSchemaAction());
		$this->assertContains('mod:err', $c->errorCodes());
		$this->assertSame([], \CUserTypeEntity::$added, 'без модулей до создания полей не доходим');
	}
}
