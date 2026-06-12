#requires -Version 5.1
# =====================================================================
#  Регрессия #58 (Windows): `claude --print` должен принимать промпт из STDIN.
#  backend/agent-runner.js шлёт промпт через stdin, а не argv — иначе большой
#  кириллический документ роняет spawn с E2BIG. Скрипт проверяет, что claude
#  читает промпт из stdin. Windows-аналог check-agent-stdin.sh.
#
#  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\check-agent-stdin.ps1
#  claude нет в PATH → пропуск (exit 0). Реальный ключ НЕ нужен (фейк → 401).
# =====================================================================
$ErrorActionPreference = "Continue"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "[SKIP] claude не найден в PATH — проверка пропущена"
  exit 0
}

# Подменяем ANTHROPIC_* на фейк, чтобы не зависеть от ambient-конфига; восстановим после.
$keys = 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'
$saved = @{}
foreach ($k in $keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
  $env:ANTHROPIC_API_KEY = 'sk-ant-invalid-0000'
  $env:ANTHROPIC_BASE_URL = ''
  $env:ANTHROPIC_AUTH_TOKEN = ''
  $out = 'ping' | claude --print --output-format json --bare 2>&1 | Out-String
}
finally {
  foreach ($k in $keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
}

$head = $out.Substring(0, [Math]::Min(300, $out.Length))
if ($out -match 'Input must be provided') {
  Write-Host "[FAIL] claude НЕ прочитал промпт из stdin — E2BIG-фикс сломан этой версией CLI:"
  Write-Host $head
  exit 1
}
if ($out -match '"type":"result"') {
  Write-Host "[OK] claude читает промпт из stdin (получен JSON-результат CLI)"
  exit 0
}
Write-Host "[OK?] claude принял stdin (нет ошибки 'no prompt'); ответ нестандартный:"
Write-Host $head
exit 0
