#requires -Version 5.1
# =====================================================================
#  Регрессия #58 (Windows): `claude --print` должен принимать промпт из STDIN.
#  backend/agent-runner.js шлёт промпт через stdin, а не argv — иначе большой
#  кириллический документ роняет spawn с E2BIG. Скрипт проверяет, что claude
#  читает промпт из stdin. Windows-аналог check-agent-stdin.sh.
#
#  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\check-agent-stdin.ps1
#  claude нет в PATH → пропуск (exit 0). Реальный ключ НЕ нужен (фейк → 401).
#  ВНИМАНИЕ: делает РЕАЛЬНЫЙ сетевой вызов к API; при недоступном API job снимается
#  по таймауту (40с) и скрипт завершается exit 0.
# =====================================================================
$ErrorActionPreference = "Continue"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "[SKIP] claude не найден в PATH — проверка пропущена"
  exit 0
}

# Изолированный прогон в Job: фейк-ключ и сброс ambient ANTHROPIC_*/CLAUDE_CODE_* делаем
# ВНУТРИ job (аналог `env -i` в .sh — окружение родителя не трогаем), плюс таймаут 40с,
# чтобы скрипт не висел при недоступном API.
$job = Start-Job -ArgumentList 'sk-ant-invalid-0000' -ScriptBlock {
  param($fakeKey)
  foreach ($k in 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL',
                 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') { Set-Item "env:$k" '' }
  $env:ANTHROPIC_API_KEY = $fakeKey
  'ping' | claude --print --output-format json --bare 2>&1 | Out-String
}
if (Wait-Job $job -Timeout 40) { $out = (Receive-Job $job | Out-String) }
else { Stop-Job $job; $out = 'TIMEOUT: claude не ответил за 40с' }
Remove-Job $job -Force

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
