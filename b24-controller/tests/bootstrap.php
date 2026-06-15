<?php
/**
 * PHPUnit bootstrap для тестов модуля shef.purchase.
 *
 * Порядок: автозагрузчик Composer (PHPUnit) → стабы рантайма Bitrix →
 * реальные классы модуля (config + контроллеры). Контроллеры подключаем
 * напрямую require'ом: на коробке их грузит автозагрузчик Bitrix, а в тестах
 * PSR-4 для них не настраиваем (файлы лежат в lib/, не в src/).
 */

$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (is_file($autoload))
{
	require $autoload;
}

// Стабы рантайма Bitrix (Engine\Controller, Error, Option, трейт Modules,
// глобальные CCrm*/CIBlock*/CRestUtil/Timeline). Должны идти ДО классов модуля.
require __DIR__ . '/stubs/bitrix.php';

// Классы модуля. config.php первым — контроллеры на него ссылаются.
$lib = dirname(__DIR__) . '/lib';
require $lib . '/config.php';
require $lib . '/controllers/procuresupplier.php';
require $lib . '/controllers/procureproduct.php';
require $lib . '/controllers/procurecontract.php';
require $lib . '/controllers/procuredeal.php';
require $lib . '/controllers/procureinstall.php';
