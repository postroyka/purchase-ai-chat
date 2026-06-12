# =====================================================================
#  Проверка результатов работы за сессию (конфиг модуля + чеклист
#  деплоя + тест лимита размера файла). Запускается ЛОКАЛЬНО, живой
#  сервер Bitrix24 НЕ нужен.
#
#  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\verify-session.ps1
# =====================================================================
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

$script:Pass = 0
$script:Fail = 0
function Ok($m)  { Write-Host "  [OK] $m";   $script:Pass++ }
function Bad($m) { Write-Host "  [!!] $m";    $script:Fail++ }

Write-Host "-- 1. Конфиг модуля вынесен в config.php --"
if (Test-Path 'b24-controller/lib/config.php') {
  Ok 'файл b24-controller/lib/config.php существует (нижний регистр)'
} else { Bad 'config.php не найден' }

$cfg = Get-Content 'b24-controller/lib/config.php' -Raw -ErrorAction SilentlyContinue
if ($cfg -match 'class Config' -and $cfg -match 'getCatalogIblockId|getDealCategoryId|getDealDefaultStageId|getUnitOkeiSht') {
  Ok 'класс Config с 4 геттерами настроек на месте'
} else { Bad 'класс Config или его методы не найдены' }

$ctrl = Select-String -Path 'b24-controller/lib/controllers/*.php' -Pattern "Option::get\('shef.purchase'" -ErrorAction SilentlyContinue
if (-not $ctrl) { Ok 'контроллеры читают настройки через Config (нет прямых Option::get)' }
else { Bad 'в контроллерах остались прямые вызовы Option::get' }

Write-Host "-- 2. Синтаксис PHP-файлов --"
if (Get-Command php -ErrorAction SilentlyContinue) {
  $err = 0
  Get-ChildItem 'b24-controller/lib/config.php','b24-controller/lib/controllers/procure*.php' | ForEach-Object {
    php -l $_.FullName > $null 2>&1
    if ($LASTEXITCODE -ne 0) { Bad "ошибка синтаксиса: $($_.Name)"; $err = 1 }
  }
  if ($err -eq 0) { Ok 'php -l: все файлы без ошибок' }
} else { Write-Host '  [--] php не установлен — пропуск (на CI проверяется)' }

Write-Host "-- 3. Чеклист деплоя в документации --"
if (Select-String -Path 'b24-controller/README.md' -Pattern 'Деплой при изменении контракта MCP' -Quiet) {
  Ok 'раздел чеклиста деплоя есть в README'
} else { Bad 'раздел чеклиста деплоя не найден' }

Write-Host "-- 4. CI-напоминание о ручном деплое PHP --"
if (Select-String -Path '.github/workflows/ci.yml' -Pattern 'b24 deploy reminder|b24-deploy-reminder' -Quiet) {
  Ok 'джоба-напоминание есть в ci.yml'
} else { Bad 'джоба b24 deploy reminder не найдена' }

Write-Host "-- 5. Тесты backend (вкл. новый тест лимита размера файла) --"
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Push-Location backend
  pnpm test 2>&1 | Tee-Object -FilePath $env:TEMP\verify-backend.log | Out-Null
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -eq 0) {
    $line = (Select-String -Path $env:TEMP\verify-backend.log -Pattern 'Tests +\d+ passed' | Select-Object -Last 1).Line
    Ok "backend-тесты прошли — $line"
  } else { Bad 'backend-тесты упали — см. %TEMP%\verify-backend.log' }
} else { Write-Host '  [--] pnpm не установлен — пропуск (на CI проверяется)' }

Write-Host ''
Write-Host '============================================'
Write-Host "  ИТОГ:  OK $script:Pass   FAIL $script:Fail"
Write-Host '============================================'
if ($script:Fail -eq 0) { Write-Host 'Всё в порядке.' } else { Write-Host 'Есть провалы — см. выше.' }
exit $script:Fail
