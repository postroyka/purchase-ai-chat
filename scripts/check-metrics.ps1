# =====================================================================
#  Проверка дашборда метрик procure-ai: GET /metrics/data → сводка.
#  Запуск:   powershell -ExecutionPolicy Bypass -File .\scripts\check-metrics.ps1
#  Локально: $env:BASE="http://localhost:3000"; $env:BACKEND_API_TOKEN="dev-token-local"; .\scripts\check-metrics.ps1
#  Самоподписанный TLS:  $env:INSECURE="1"
#
#  Переменные: BASE (иначе https://$DOMAIN), DOMAIN, INSECURE,
#              BACKEND_API_TOKEN (или берётся из .env.prod рядом).
#  Скопируйте весь вывод и пришлите.
# =====================================================================
$ErrorActionPreference = "Stop"

$Base = if ($env:BASE) { $env:BASE } elseif ($env:DOMAIN) { "https://$($env:DOMAIN)" } else { "http://localhost:3000" }

$Token = $env:BACKEND_API_TOKEN
if (-not $Token -and (Test-Path ".env.prod")) {
  $line = Select-String -Path ".env.prod" -Pattern '^BACKEND_API_TOKEN=' | Select-Object -First 1
  if ($line) { $Token = ($line.Line -replace '^BACKEND_API_TOKEN=', '').Trim().Trim('"').Trim("'") }
}
if (-not $Token -or $Token -eq "replace-with-secure-token") {
  Write-Host "[FAIL] Нет BACKEND_API_TOKEN (в окружении или .env.prod рядом)." -ForegroundColor Red
  exit 1
}

$url = "$Base/metrics/data"
Write-Host "Метрики procure-ai  ->  $url"
Write-Host "Дата: $(Get-Date)"
Write-Host "---------------------------------------------"

$iwr = @{ Uri = $url; Headers = @{ Authorization = "Bearer $Token" }; TimeoutSec = 30; Method = "Get" }
if ($env:INSECURE -eq "1" -and $PSVersionTable.PSVersion.Major -ge 6) { $iwr["SkipCertificateCheck"] = $true }

try {
  $d = Invoke-RestMethod @iwr
} catch {
  Write-Host "[FAIL] Запрос не удался: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$t = $d.totals; $e = $d.economics
function Brk($arr, $n = 99) { ($arr | Select-Object -First $n | ForEach-Object { "$($_.name)=$($_.count)" }) -join ", " }

Write-Host ("Загрузок:            {0}" -f $t.uploads)
Write-Host ("Файлов:              {0} (done {1} / error {2})" -f $t.files, $t.filesDone, $t.filesError)
Write-Host ("Успешных сделок:     {0} ({1}%)" -f $t.ok, $t.successRatePct)
Write-Host ('Стоимость, всего:     ${0}  (прогонов с ценой: {1})' -f $t.costUsd, $t.costRuns)
Write-Host ("Сред. время агента:  {0} мс" -f $t.avgAgentMs)
Write-Host ""
Write-Host ("Топ исходов:         {0}" -f (Brk $d.outcomes 5))
Write-Host ("Форматы:             {0}" -f (Brk $d.formats))
Write-Host ("Извлечение:          {0}" -f (Brk $d.extract))

if ($e.enabled) {
  Write-Host ""
  Write-Host ("ЭКОНОМИКА (оценка; ставка {0} BYN/ч, {1} мин/поз):" -f $e.hourlyRateByn, $e.minutesPerPosition)
  Write-Host ("  Сэкономлено (нетто):        {0} BYN" -f $e.netSavedByn)
  Write-Host ("  Потеря на пустых артикулах: {0} BYN ({1}% позиций без артикула)" -f $e.lostNoArticleByn, $e.positionsNoArticlePct)
  Write-Host ("  Позиций:                    {0} (без артикула: {1})" -f $e.positions, $e.positionsNoArticle)
  $rateDate = if ($e.usdBynDate) { ", $($e.usdBynDate)" } else { "" }
  Write-Host ("  Курс USD->BYN:              {0} (источник: {1}{2})" -f $e.usdByn, $e.usdBynSource, $rateDate)
} else {
  Write-Host ""
  Write-Host "ЭКОНОМИКА: выключена (HOURLY_RATE_BYN=0)"
}
Write-Host "---------------------------------------------"
Write-Host "[OK] /metrics/data доступен." -ForegroundColor Green
