# Smoke-тест PHP REST-контроллеров procure-ai на живой коробке Bitrix24.
#
# Использование:
#   $env:WEBHOOK_URL = "https://your-b24.domain/rest/1/TOKEN/"
#   .\scripts\smoke-test-b24.ps1
#
# Или с параметрами:
#   .\scripts\smoke-test-b24.ps1 -WebhookUrl "https://..." -SupplierId 42

param(
    [string]$WebhookUrl      = $env:WEBHOOK_URL,
    [int]   $SupplierId      = $(if ($env:SUPPLIER_ID) { [int]$env:SUPPLIER_ID } else { 42 }),
    [string]$VendorCode      = $(if ($env:VENDOR_CODE) { $env:VENDOR_CODE } else { "ART-12345" }),
    [int]   $ResponsibleUser = $(if ($env:RESPONSIBLE_USER_ID) { [int]$env:RESPONSIBLE_USER_ID } else { 1 }),
    [string]$SupplierUnp     = $(if ($env:SUPPLIER_UNP) { $env:SUPPLIER_UNP } else { "100059180" })
)

if (-not $WebhookUrl) {
    throw "Задайте WEBHOOK_URL: `$env:WEBHOOK_URL = 'https://your-portal/rest/1/TOKEN/'"
}
$B24 = $WebhookUrl.TrimEnd('/')

$FakeB64 = [Convert]::ToBase64String(
    [System.Text.Encoding]::UTF8.GetBytes('%PDF-1.4 1 0 obj<</Type/Catalog>>endobj')
)

function Invoke-B24 {
    param([string]$Method, [object]$Body, [switch]$ExpectError)
    Write-Host ""
    Write-Host "===== $Method =====" -ForegroundColor Cyan
    $json = $Body | ConvertTo-Json -Depth 10
    try {
        $resp = Invoke-RestMethod -Uri "$B24/$Method" -Method POST `
            -ContentType "application/json" -Body $json
        $resp | ConvertTo-Json -Depth 10
    }
    catch {
        if ($ExpectError) {
            Write-Host "(Ожидаемая ошибка: $_)" -ForegroundColor DarkYellow
        }
        else {
            Write-Host "HTTP Error: $_" -ForegroundColor Red
        }
    }
}

# ── 1. procuresupplier.findbyunp ─────────────────────────────────────────────
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1a — реальный УНП" @{ unp = $SupplierUnp }
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1b — несуществующий (ожидаем id=null)" @{ unp = "000000001" }
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1c — пустой (ожидаем error)" @{ unp = "" } -ExpectError
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1d — слишком длинный (ожидаем error)" @{ unp = "A" * 40 } -ExpectError

# ── 2. procurecontract.find ───────────────────────────────────────────────────
Invoke-B24 "shef:purchase.api.procurecontract.find/2a — только supplierId" @{ supplierId = $SupplierId }
Invoke-B24 "shef:purchase.api.procurecontract.find/2b — с number и date" @{
    supplierId = $SupplierId; number = "ДОГ-2024/001"; date = "01.01.2024"
}
Invoke-B24 "shef:purchase.api.procurecontract.find/2c — несуществующий (ожидаем id=null)" @{ supplierId = 999999 }
Invoke-B24 "shef:purchase.api.procurecontract.find/2d — supplierId=0 (ожидаем error)" @{ supplierId = 0 } -ExpectError

# ── 3. procureproduct.findbyvendorcode ────────────────────────────────────────
Invoke-B24 "shef:purchase.api.procureproduct.findbyvendorcode/3a — реальный артикул" @{ vendorCode = $VendorCode }
Invoke-B24 "shef:purchase.api.procureproduct.findbyvendorcode/3b — несуществующий (ожидаем id=null)" @{ vendorCode = "NONEXISTENT-ZZZZZ-99999" }
Invoke-B24 "shef:purchase.api.procureproduct.findbyvendorcode/3c — пустой (ожидаем error)" @{ vendorCode = "" } -ExpectError
Invoke-B24 "shef:purchase.api.procureproduct.findbyvendorcode/3d — слишком длинный (ожидаем error)" @{
    vendorCode = "A" * 65
} -ExpectError

# ── 4. procuredeal.create ─────────────────────────────────────────────────────
Invoke-B24 "shef:purchase.api.procuredeal.create/4a — минимальный запрос" @{
    supplierId        = $SupplierId
    responsibleUserId = $ResponsibleUser
    fileName          = "smoke-test-invoice.pdf"
    fileContent       = $FakeB64
    processingLog     = "Smoke-test 4a PowerShell"
    items             = @(@{ name = "Болт М8"; priceExclVat = 1.5; quantity = 100 })
}

Invoke-B24 "shef:purchase.api.procuredeal.create/4b — с contractId" @{
    supplierId        = $SupplierId
    responsibleUserId = $ResponsibleUser
    contractId        = 1
    fileName          = "smoke-test-invoice.pdf"
    fileContent       = $FakeB64
    processingLog     = "Smoke-test 4b с contractId"
    items             = @(
        @{ vendorCode = $VendorCode; name = "Болт М8"; priceExclVat = 1.5; quantity = 10 },
        @{ name = "Гайка М8 (без артикула)"; priceExclVat = 0.5; quantity = 50 }
    )
}

Invoke-B24 "shef:purchase.api.procuredeal.create/4c — supplierId=0 (ожидаем error)" @{
    supplierId = 0; responsibleUserId = 1
    fileName = "x.pdf"; fileContent = "dGVzdA=="
    processingLog = ""; items = @(@{ name = "x"; priceExclVat = 1; quantity = 1 })
} -ExpectError

Invoke-B24 "shef:purchase.api.procuredeal.create/4d — пустой items[] (ожидаем error)" @{
    supplierId = $SupplierId; responsibleUserId = $ResponsibleUser
    fileName = "x.pdf"; fileContent = "dGVzdA=="
    processingLog = ""; items = @()
} -ExpectError

Write-Host ""
Write-Host "✅ Smoke-тест завершён." -ForegroundColor Green
Write-Host "⚠️  Проверьте CRM Bitrix24 — удалите тестовые сделки из тестов 4a и 4b вручную." -ForegroundColor Yellow
