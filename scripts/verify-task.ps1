# =====================================================================
#  Проверка РЕЗУЛЬТАТОВ задачи (ревью + правки PR #48) с рабочего компьютера.
#  Проверяет: /health; basic-auth публичной страницы (401 без логина / 200 с
#  логином / 401 с неверным паролем); dual-auth на API (Bearer и Basic).
#
#  Запуск (PowerShell):
#     powershell -ExecutionPolicy Bypass -File .\verify-task.ps1 `
#        -Base "https://purchase.postroyka.by" -Pass "<PUBLIC_PAGE_BASIC_AUTH_PASS>" -Token "<BACKEND_API_TOKEN>"
#
#  Скрипт ничего не меняет. Скопируйте ВЕСЬ вывод и пришлите.
# =====================================================================
param(
  [string]$Base  = "https://purchase.postroyka.by",
  [string]$User  = "procure",
  [string]$Pass  = "",
  [string]$Token = "",
  [switch]$Insecure
)

$script:pass = 0; $script:fail = 0; $script:skip = 0
function OkMsg($m)   { Write-Host "[ OK ] $m";  $script:pass++ }
function BadMsg($m)  { Write-Host "[FAIL] $m";  $script:fail++ }
function SkipMsg($m) { Write-Host "[ -- ] $m";  $script:skip++ }

$k = @(); if ($Insecure) { $k = @("-k") }
function Code([string[]]$extra) {
  (& curl.exe -s -o NUL -w "%{http_code}" --max-time 15 $k $extra) 2>$null
}

Write-Host "Проверка результатов задачи (auth).  Base: $Base"
Write-Host "Дата: $(Get-Date)"

Write-Host "`n=== 1. Health ==="
if ((Code @("$Base/health")) -eq "200") { OkMsg "/health → 200" } else { BadMsg "/health не отвечает 200" }

Write-Host "`n=== 2. Basic-auth публичной страницы ==="
$h = (& curl.exe -s -o NUL -D - -w "CODE:%{http_code}" --max-time 15 $k "$Base/") 2>$null | Out-String
$c = ([regex]::Match($h, "CODE:(\d+)")).Groups[1].Value
if ($c -eq "401" -and $h -match "(?i)WWW-Authenticate:\s*Basic") {
  OkMsg "GET / без логина → 401 + WWW-Authenticate: Basic (страница закрыта паролем)"
} elseif ($c -eq "401") {
  BadMsg "GET / → 401, но без заголовка WWW-Authenticate: Basic"
} else {
  BadMsg "GET / без логина → $c (ожидался 401)"
}
if ($Pass -and $Pass -ne "replace-with-secure-password") {
  if ((Code @("-u","$($User):$($Pass)","$Base/")) -eq "200") { OkMsg "GET / с верным логином → 200" } else { BadMsg "GET / с верным логином → не 200" }
  $wc = Code @("-u","$($User):nope123","$Base/")
  if ($wc -eq "401") { OkMsg "GET / с неверным паролем → 401" } else { BadMsg "GET / с неверным паролем → $wc (ожидался 401)" }
} else { SkipMsg "проверка логина пропущена: укажите -Pass" }

Write-Host "`n=== 3. Dual-auth на API (/job/:id/status) ==="
if ((Code @("$Base/job/verify-x/status")) -eq "401") { OkMsg "без авторизации → 401" } else { BadMsg "без авторизации → не 401" }
if ($Pass -and $Pass -ne "replace-with-secure-password") {
  $bc = Code @("-u","$($User):$($Pass)","$Base/job/verify-x/status")
  if ($bc -eq "404") { OkMsg "с Basic-логином → 404 (Basic принимается на API)" } else { BadMsg "с Basic → $bc (ожидался 404)" }
}
if ($Token -and $Token -ne "replace-with-secure-token") {
  $tc = Code @("-H","Authorization: Bearer $Token","$Base/job/verify-x/status")
  if ($tc -eq "404") { OkMsg "с Bearer-токеном → 404 (токен работает)" } else { BadMsg "с Bearer → $tc (ожидался 404)" }
} else { SkipMsg "Bearer-проверка пропущена: укажите -Token" }

Write-Host "`n=== ИТОГ ==="
Write-Host "OK: $($script:pass)   FAIL: $($script:fail)   Пропущено: $($script:skip)"
if ($script:fail -eq 0) { Write-Host "OK Результаты задачи подтверждены." } else { Write-Host "!! Есть строки [FAIL] — скопируйте весь вывод и пришлите." }
