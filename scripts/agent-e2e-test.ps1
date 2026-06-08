# =====================================================================
#  Сквозной тест агента (#36 runAgent) — Windows / PowerShell.
#
#  Аналог scripts/agent-e2e-test.sh для локальной проверки на Windows,
#  где claude авторизован по подписке (вне Docker). Грузит счёт через
#  /upload, опрашивает /job/:id/status, печатает понятный вердикт.
#
#  Запуск (бэкенд уже поднят локально):
#     powershell -ExecutionPolicy Bypass -File .\scripts\agent-e2e-test.ps1
#
#  Со своим файлом / другим хостом / токеном:
#     .\scripts\agent-e2e-test.ps1 -File C:\path\price.xlsx -Base http://localhost:3000 -Token dev-token-local
#
#  По умолчанию берётся эталонный счёт scripts/samples/etalon-invoice.pdf
#  рядом со скриптом. Токен — из параметра, иначе из $env:BACKEND_API_TOKEN,
#  иначе из .env / backend/.env в текущей папке.
#
#  ⚠️ Week 1: MCP-инструменты — заглушки. «Уровень 1 PASS» = агент
#  запустился, авторизовался, прочитал файл и дошёл до MCP.
# =====================================================================
param(
  [string]$Base = $env:BASE,
  [string]$Token = $env:BACKEND_API_TOKEN,
  [string]$File = "",
  [string]$ResponsibleId = $env:RESPONSIBLE_ID,
  [int]$PollTimeout = 360,
  [string]$AppContainer = "procure-app"
)
$ErrorActionPreference = 'Stop'
if (-not $Base) { $Base = 'http://localhost:3000' }

function Read-EnvToken([string]$path) {
  if (Test-Path $path) {
    $line = Select-String -Path $path -Pattern '^BACKEND_API_TOKEN=' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($line) { return ($line.Line -replace '^BACKEND_API_TOKEN=', '' -replace '["'']', '').Trim() }
  }
  return ""
}

# --- Токен ----------------------------------------------------------------
if (-not $Token) { $Token = Read-EnvToken '.env' }
if (-not $Token) { $Token = Read-EnvToken 'backend\.env' }
if (-not $Token -or $Token -eq 'replace-with-secure-token') {
  Write-Host "X Нет BACKEND_API_TOKEN (параметр -Token, либо `$env:BACKEND_API_TOKEN, либо .env). Прерываю." -ForegroundColor Red
  exit 1
}

# --- Файл: -File, иначе эталон рядом со скриптом ---------------------------
if (-not $File) {
  $candidates = @(
    (Join-Path $PSScriptRoot 'samples\etalon-invoice.pdf'),
    (Join-Path $PSScriptRoot 'etalon-invoice.pdf'),
    '.\etalon-invoice.pdf'
  )
  $File = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $File -or -not (Test-Path $File)) {
  Write-Host "X Тестовый файл не найден. Укажите -File <путь> или положите scripts/samples/etalon-invoice.pdf." -ForegroundColor Red
  exit 1
}
$File = (Resolve-Path $File).Path

$ctype = switch ([IO.Path]::GetExtension($File).ToLower()) {
  '.pdf'  { 'application/pdf' }
  '.xlsx' { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  '.docx' { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  default { 'application/octet-stream' }
}

Write-Host "Сквозной тест агента procure-ai (Windows)"
Write-Host "Дата: $(Get-Date)"
Write-Host "Base: $Base"
Write-Host "Файл: $File"

# --- 1. Загрузка ----------------------------------------------------------
Write-Host "`n=== 1. Загрузка файла -> POST /upload ==="
$formArg = "files[]=@$File;type=$ctype"
$curlArgs = @('-s', '-X', 'POST', "$Base/upload", '-H', "Authorization: Bearer $Token", '-F', $formArg)
if ($ResponsibleId) { $curlArgs += @('-F', "responsibleUserId=$ResponsibleId") }
$resp = & curl.exe @curlArgs
Write-Host "Ответ: $resp"

try { $jobId = ($resp | ConvertFrom-Json).jobId } catch { $jobId = $null }
if (-not $jobId) {
  Write-Host "X Не удалось получить jobId — загрузка не прошла. Проверьте токен/Base/бэкенд." -ForegroundColor Red
  exit 1
}
Write-Host "OK jobId: $jobId" -ForegroundColor Green

# --- 2. Опрос статуса -----------------------------------------------------
Write-Host "`n=== 2. Ожидание обработки -> GET /job/$jobId/status ==="
$start = Get-Date
$statusObj = $null
$jobStatus = '?'
while ($true) {
  Start-Sleep -Seconds 3
  try {
    $sj = & curl.exe -s -H "Authorization: Bearer $Token" "$Base/job/$jobId/status"
    $statusObj = $sj | ConvertFrom-Json
    $jobStatus = $statusObj.status
  } catch { $jobStatus = '?' }
  $elapsed = [int]((Get-Date) - $start).TotalSeconds
  Write-Host ("  [{0,3}s] статус job: {1}" -f $elapsed, $jobStatus)
  if ($jobStatus -eq 'done' -or $jobStatus -eq 'error') { break }
  if ($elapsed -ge $PollTimeout) {
    Write-Host "! Таймаут ожидания ($PollTimeout с). Агент мог ещё работать." -ForegroundColor Yellow
    break
  }
}

Write-Host "Полный ответ статуса:"
if ($statusObj) { $statusObj | ConvertTo-Json -Depth 6 } else { Write-Host $sj }

$fileStatus = $null; $fileError = $null
if ($statusObj -and $statusObj.files) {
  $fileStatus = $statusObj.files[0].status
  $fileError  = [string]$statusObj.files[0].error
}

# --- 3. Логи агента (если backend в Docker на этой машине) ----------------
Write-Host "`n=== 3. Логи агента ==="
try {
  $hasContainer = $false
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    $null = docker inspect $AppContainer 2>$null
    if ($LASTEXITCODE -eq 0) { $hasContainer = $true }
  }
  if ($hasContainer) {
    docker logs --tail 400 $AppContainer 2>&1 |
      Select-String -Pattern '\[agent', '\[processJob', $jobId | Select-Object -Last 40
  } else {
    Write-Host "(контейнер $AppContainer не найден — при локальном запуске смотрите консоль, где запущен backend)"
  }
} catch {
  Write-Host "(не удалось прочитать логи контейнера — пропускаю)"
}

# --- 4. Вердикт -----------------------------------------------------------
Write-Host "`n=== ВЕРДИКТ ==="
Write-Host ("job.status={0}  file.status={1}" -f $jobStatus, $fileStatus)
if ($fileError) { Write-Host ("file.error={0}" -f $fileError) }
$lowErr = ([string]$fileError).ToLower()

if ($fileStatus -eq 'done') {
  Write-Host "OK ПОЛНЫЙ УСПЕХ: агент отработал и вернул результат (MCP уже отвечает?)." -ForegroundColor Green
} elseif ($lowErr -match 'not found|enoent|no such file|cli not found') {
  Write-Host "X FAIL: claude CLI не найден (ENOENT). Проверьте установку claude и PATH/CLAUDE_CODE_BIN." -ForegroundColor Red
} elseif ($lowErr -match 'not logged in|/login|invalid api key|authentication') {
  Write-Host "X FAIL: агент не авторизован. Выполните 'claude login' (или задайте ANTHROPIC_API_KEY)." -ForegroundColor Red
} elseif ($lowErr -match 'mcp|connect|econnrefused|fetch failed|tool .* not|getaddrinfo|socket hang up') {
  Write-Host "OK УРОВЕНЬ 1 PASS: агент запустился, авторизовался, прочитал файл и дошёл до MCP" -ForegroundColor Green
  Write-Host "   (упёрся в заглушку/недоступность инструментов — ожидаемо на Week 1). runAgent (#36) работает." -ForegroundColor Green
} elseif ($jobStatus -eq 'error' -or $fileStatus -eq 'error') {
  Write-Host "! Агент завершился ошибкой, не распознанной автоматически. Смотрите file.error и логи выше." -ForegroundColor Yellow
} else {
  Write-Host "! Непонятное состояние (возможно таймаут). Пришлите весь вывод." -ForegroundColor Yellow
}
Write-Host "`nГотово. Скопируйте весь вывод и пришлите."
