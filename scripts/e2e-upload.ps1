# =====================================================================
#  Сквозная проверка procure-ai СНАРУЖИ (Windows, PowerShell 7+).
#  Загружает тестовый PDF и опрашивает статус задания — прогоняет весь путь
#  nginx → backend → агент → MCP. Создаёт РЕАЛЬНОЕ задание.
#
#  Запуск (PowerShell 7+):
#     pwsh -File .\e2e-upload.ps1 -Token "ВАШ_BACKEND_API_TOKEN"
#  Самоподписанный сертификат:  добавьте -Insecure
#  Другой домен:                -Domain purchase.postroyka.by
#
#  Скопируйте весь вывод и пришлите его.
# =====================================================================
param(
    [string]$Domain = "purchase.postroyka.by",
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$TimeoutSec = 300,
    [switch]$Insecure
)

$ErrorActionPreference = "Stop"
$base = "https://$Domain"
$common = @{ Headers = @{ Authorization = "Bearer $Token" } }
if ($Insecure) { $common.SkipCertificateCheck = $true }

Write-Host "Сквозная проверка procure-ai  (домен: $Domain)"
Write-Host ("Дата: " + (Get-Date))

# Минимальный валидный PDF (file-type определит по сигнатуре %PDF).
$tmp = Join-Path $env:TEMP ("e2e-" + [guid]::NewGuid().ToString() + ".pdf")
@"
%PDF-1.4
1 0 obj
<< /Type /Catalog >>
endobj
trailer
<< /Root 1 0 R >>
%%EOF
"@ | Set-Content -Path $tmp -Encoding ascii

try {
    Write-Host "`n=== 1. Загрузка файла (POST /upload) ==="
    $up = Invoke-RestMethod -Uri "$base/upload" -Method Post -Form @{ 'files[]' = Get-Item $tmp } @common
    $jobId = $up.jobId
    if (-not $jobId) { Write-Host "[FAIL] Не получили jobId — загрузка не удалась."; exit 1 }
    Write-Host "[ OK ] jobId=$jobId"

    Write-Host "`n=== 2. Опрос статуса (до ${TimeoutSec}s) ==="
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $status = ""
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Invoke-RestMethod -Uri "$base/job/$jobId/status" @common
        $status = $last.status
        Write-Host "  status=$status"
        if ($status -eq "done" -or $status -eq "error") { break }
        Start-Sleep -Seconds 3
    }
    if ($last) { Write-Host "Финальный ответ:"; $last | ConvertTo-Json -Depth 6 | Write-Host }

    Write-Host "`n=== ИТОГ ==="
    switch ($status) {
        "done"  { Write-Host "OK: задание завершено (done)." }
        "error" { Write-Host "WARN: status=error — смотрите поле error по файлам выше."
                  Write-Host "      На текущем этапе это ОЖИДАЕМО: MCP-инструменты b24_pst_crm_* — заглушки." }
        default { Write-Host "TIMEOUT: не дождались терминального статуса за ${TimeoutSec}s (последний: $status)." }
    }
} catch {
    Write-Host ("[FAIL] " + $_.Exception.Message)
    if ($_.Exception.Response) { Write-Host ("HTTP " + [int]$_.Exception.Response.StatusCode) }
    exit 1
} finally {
    Remove-Item -Path $tmp -ErrorAction SilentlyContinue
}
