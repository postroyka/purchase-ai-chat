#requires -Version 5.1
# =====================================================================
#  UI-смоук procure-ai (Windows): ESLint + TypeScript (nuxt typecheck) + инварианты.
#  Windows-аналог ui-smoke.sh.
#
#  Запуск:  powershell -ExecutionPolicy Bypass -File scripts\ui-smoke.ps1
#  Любой провал → exit 1. Скопируйте весь вывод и пришлите при проблемах.
# =====================================================================
$ErrorActionPreference = "Continue"
Set-Location (Join-Path (Split-Path -Parent $PSScriptRoot) "ui")

$fail = 0
function Step($t) { Write-Host "`n=== $t ===" }

Step "ESLint"
pnpm exec eslint .
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] eslint"; $fail = 1 } else { Write-Host "[OK] eslint" }

Step "TypeScript (nuxt typecheck)"
pnpm typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] typecheck"; $fail = 1 } else { Write-Host "[OK] typecheck" }

Step "Инварианты"
$userMenu = Get-ChildItem -Path "app" -Recurse -File -ErrorAction SilentlyContinue |
  Select-String -Pattern "import.*UserMenu|<UserMenu|components/UserMenu" -ErrorAction SilentlyContinue
if ($userMenu) { Write-Host "[FAIL] остались ссылки на компонент UserMenu"; $fail = 1 }
else { Write-Host "[OK] компонент UserMenu не используется" }

Write-Host ""
if ($fail -eq 0) { Write-Host "[OK] UI-смоук пройден" } else { Write-Host "[FAIL] UI-смоук со сбоями" }
exit $fail
