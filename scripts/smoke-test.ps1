# =====================================================================
#  Проверка procure-ai СНАРУЖИ (с обычного компьютера на Windows).
#  Проверяет, что сайт доступен из интернета: DNS, порт, сертификат, /health.
#
#  Запуск (просто двойной клик может не сработать — запускайте так):
#     1) Открыть PowerShell
#     2) Выполнить одну строку:
#        powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1
#
#  Можно указать другой домен:
#        powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1 -Domain purchase.postroyka.by
#
#  Скрипт ничего не меняет. Скопируйте весь вывод и пришлите его.
# =====================================================================
param(
    [string]$Domain = "purchase.postroyka.by",
    # Необязательно: Bearer-токен backend для позитивной проверки авторизации.
    # Пример: ... -File .\smoke-test.ps1 -Token "ваш_BACKEND_API_TOKEN"
    [string]$Token = ""
)

$pass = 0; $fail = 0
function Ok($m)  { Write-Host "[ OK ] $m" -ForegroundColor Green; $script:pass++ }
function Bad($m) { Write-Host "[FAIL] $m" -ForegroundColor Red;   $script:fail++ }
function Hdr($m) { Write-Host ""; Write-Host "=== $m ===" -ForegroundColor Cyan }

Write-Host "Проверка procure-ai снаружи  (домен: $Domain)"
Write-Host ("Дата: " + (Get-Date))

# ---------------------------------------------------------------------
Hdr "1. DNS — резолвится ли домен"
try {
    $addrs = [System.Net.Dns]::GetHostAddresses($Domain)
    Ok ("DNS $Domain -> " + ($addrs | ForEach-Object { $_.IPAddressToString }) -join ", ")
} catch {
    Bad "DNS не резолвится: $Domain"
}

# ---------------------------------------------------------------------
Hdr "2. Порт 443 — открыт ли"
try {
    $tcp = Test-NetConnection -ComputerName $Domain -Port 443 -WarningAction SilentlyContinue
    if ($tcp.TcpTestSucceeded) { Ok "TCP 443 открыт" } else { Bad "TCP 443 недоступен" }
} catch {
    Bad "Не удалось проверить порт 443: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------
Hdr "3. HTTPS /health — отвечает ли приложение"
try {
    $r = Invoke-WebRequest -Uri "https://$Domain/health" -TimeoutSec 15 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
        Ok "/health -> 200  $($r.Content)"
    } else {
        Bad "/health -> $($r.StatusCode)"
    }
} catch {
    $resp = $_.Exception.Response
    if ($resp) {
        Bad ("/health -> код " + [int]$resp.StatusCode)
    } else {
        Bad "/health ошибка соединения/сертификата: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------
Hdr "4. Главная страница (ожидается 200 или 401 basic auth)"
try {
    $r = Invoke-WebRequest -Uri "https://$Domain/" -TimeoutSec 15 -UseBasicParsing
    Ok "/ -> $($r.StatusCode) (страница отвечает)"
} catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 401) {
        Ok "/ -> 401 (страница отвечает, требует пароль — это нормально)"
    } elseif ($resp) {
        Bad ("/ -> код " + [int]$resp.StatusCode)
    } else {
        Bad "/ ошибка: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------
Hdr "5. Авторизация (запрос без токена должен давать 401)"
try {
    $r = Invoke-WebRequest -Uri "https://$Domain/job/smoke-test/status" -TimeoutSec 15 -UseBasicParsing
    Bad "/job/.../status без токена -> $($r.StatusCode) (ожидался 401)"
} catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 401) {
        Ok "/job/.../status без токена -> 401 (защита работает)"
    } elseif ($resp) {
        Bad ("/job/.../status без токена -> код " + [int]$resp.StatusCode + " (ожидался 401)")
    } else {
        Bad "/job/.../status ошибка: $($_.Exception.Message)"
    }
}

# Позитивная проверка: с верным токеном запрос должен пройти авторизацию (ожидаем 404).
if ($Token -ne "") {
    try {
        $r = Invoke-WebRequest -Uri "https://$Domain/job/smoke-test/status" -TimeoutSec 15 -UseBasicParsing -Headers @{ Authorization = "Bearer $Token" }
        Bad "/job/.../status с токеном -> $($r.StatusCode) (ожидался 404)"
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and [int]$resp.StatusCode -eq 404) {
            Ok "/job/.../status с токеном -> 404 (авторизация проходит)"
        } elseif ($resp) {
            Bad ("/job/.../status с токеном -> код " + [int]$resp.StatusCode + " (ожидался 404)")
        } else {
            Bad "/job/.../status с токеном ошибка: $($_.Exception.Message)"
        }
    }
} else {
    Write-Host "[--] позитивная проверка авторизации пропущена (передайте -Token)"
}

# ---------------------------------------------------------------------
Hdr "ИТОГ"
Write-Host "Успешно: $pass    Ошибок: $fail"
if ($fail -eq 0) {
    Write-Host "OK Сервер доступен из интернета." -ForegroundColor Green
} else {
    Write-Host "Есть проблемы — смотрите строки [FAIL] выше и пришлите весь вывод." -ForegroundColor Yellow
}
