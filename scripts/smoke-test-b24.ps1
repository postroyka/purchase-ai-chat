# Smoke-тест PHP REST-контроллеров procure-ai на живой коробке Bitrix24.
#
# Использование (вариант 1 — заполнить scripts/.env.deploy один раз):
#   Copy-Item scripts/.env.deploy.example scripts/.env.deploy   # затем заполнить
#   ./scripts/smoke-test-b24.ps1
#
# Использование (вариант 2 — через env / параметры):
#   $env:WEBHOOK_URL = "https://your-b24/rest/1/TOKEN/"; ./scripts/smoke-test-b24.ps1
#   ./scripts/smoke-test-b24.ps1 -WebhookUrl "https://..." -SupplierId 42
#
# Приоритет значений: параметр командной строки → $env: → scripts/.env.deploy → дефолт.

param(
    [string]$WebhookUrl,
    [int]   $SupplierId,
    [string]$VendorCode,
    [int]   $ResponsibleUser,
    [string]$SupplierUnp,
    [string]$ContractNumber,
    [string]$ContractDate
)

# Читаем scripts/.env.deploy (KEY=VALUE), если есть, в хэш-таблицу $FileEnv.
$FileEnv = @{}
$envFile = Join-Path $PSScriptRoot '.env.deploy'
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        $t = $line.Trim()
        if ($t -and -not $t.StartsWith('#') -and $t.Contains('=')) {
            $k, $v = $t.Split('=', 2)
            $FileEnv[$k.Trim()] = $v.Trim()
        }
    }
}

# Резолв одного значения: параметр → $env: → .env.deploy → дефолт.
function Resolve-Val($paramVal, $envName, $default) {
    if ($paramVal) { return $paramVal }
    $envVal = [Environment]::GetEnvironmentVariable($envName)
    if ($envVal)                         { return $envVal }
    if ($FileEnv.ContainsKey($envName))  { return $FileEnv[$envName] }
    return $default
}

# Bitrix отдаёт JSON с \uXXXX-экранированием кириллицы; ConvertTo-Json и тело
# ошибки тоже бывают в \uXXXX. Раскодируем в читаемый текст.
function Show-Readable($s) {
    [regex]::Replace($s, '\\u([0-9a-fA-F]{4})', { param($m) [char][int]('0x' + $m.Groups[1].Value) })
}

$WebhookUrl      = Resolve-Val $WebhookUrl      'WEBHOOK_URL'         $null
$SupplierId      = [int](Resolve-Val $SupplierId      'SUPPLIER_ID'         42)
$VendorCode      =      Resolve-Val $VendorCode      'VENDOR_CODE'         'ART-12345'
$ResponsibleUser = [int](Resolve-Val $ResponsibleUser 'RESPONSIBLE_USER_ID' 1)
$SupplierUnp     =      Resolve-Val $SupplierUnp     'SUPPLIER_UNP'        '100059180'
$ContractNumber  =      Resolve-Val $ContractNumber  'CONTRACT_NUMBER'     ''
$ContractDate    =      Resolve-Val $ContractDate    'CONTRACT_DATE'       ''

if (-not $WebhookUrl) {
    throw "Задайте WEBHOOK_URL (в scripts/.env.deploy, env или -WebhookUrl): https://your-portal/rest/1/TOKEN/"
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
        Show-Readable ($resp | ConvertTo-Json -Depth 10)
    }
    catch {
        # Bitrix отдаёт ошибки валидации как HTTP 4xx с JSON-телом
        # ({"error":"sup:011",...}). В PowerShell это тело лежит в
        # $_.ErrorDetails.Message — показываем его, а не только текст исключения.
        $errBody = $_.ErrorDetails.Message
        $color   = if ($ExpectError) { 'DarkYellow' } else { 'Red' }
        $label   = if ($ExpectError) { '(Ожидаемая ошибка)' } else { 'HTTP Error' }
        if ($errBody) {
            Write-Host "$label`: $(Show-Readable $errBody)" -ForegroundColor $color
        }
        else {
            Write-Host "$label`: $_" -ForegroundColor $color
        }
    }
}

# ── 1. procuresupplier.findbyunp ─────────────────────────────────────────────
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1a — реальный УНП" @{ unp = $SupplierUnp }
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1b — несуществующий (ожидаем id=null)" @{ unp = "000000001" }
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1c — пустой (ожидаем error)" @{ unp = "" } -ExpectError
Invoke-B24 "shef:purchase.api.procuresupplier.findbyunp/1d — слишком длинный (ожидаем error)" @{ unp = "A" * 40 } -ExpectError

# ── 2. procurecontract.find ───────────────────────────────────────────────────
# Контроллер фильтрует по номеру И дате как ТОЧНОЕ совпадение (логическое И):
# верны оба → договор найден; ошибка хотя бы в одном → result.id=null.
$WrongNumber = "НЕТ-ТАКОГО-НОМЕРА-XYZ"
$WrongDate   = "01.01.1990"

Invoke-B24 "shef:purchase.api.procurecontract.find/2a — только supplierId" @{ supplierId = $SupplierId }

if ($ContractNumber -and $ContractDate) {
    Invoke-B24 "shef:purchase.api.procurecontract.find/2b — number+date ОБА верные (ожидаем найден)" @{
        supplierId = $SupplierId; number = $ContractNumber; date = $ContractDate
    }
    Invoke-B24 "shef:purchase.api.procurecontract.find/2c — number верный, date НЕВЕРНАЯ (ожидаем id=null)" @{
        supplierId = $SupplierId; number = $ContractNumber; date = $WrongDate
    }
    Invoke-B24 "shef:purchase.api.procurecontract.find/2d — number НЕВЕРНЫЙ, date верная (ожидаем id=null)" @{
        supplierId = $SupplierId; number = $WrongNumber; date = $ContractDate
    }
}
else {
    Write-Host "`n===== 2b–2d ПРОПУЩЕНЫ — задайте CONTRACT_NUMBER и CONTRACT_DATE в scripts/.env.deploy =====" -ForegroundColor Yellow
}

Invoke-B24 "shef:purchase.api.procurecontract.find/2e — несуществующий (ожидаем id=null)" @{ supplierId = 999999 }
Invoke-B24 "shef:purchase.api.procurecontract.find/2f — supplierId=0 (ожидаем error)" @{ supplierId = 0 } -ExpectError

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

Invoke-B24 "shef:purchase.api.procuredeal.create/4b — с contractId и documentDate (BEGINDATE = 15.03.2025 09:00)" @{
    supplierId        = $SupplierId
    responsibleUserId = $ResponsibleUser
    contractId        = 1
    documentDate      = "15.03.2025"
    fileName          = "smoke-test-invoice.pdf"
    fileContent       = $FakeB64
    processingLog     = "Smoke-test 4b с contractId и documentDate"
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
