#requires -Version 5.1
# =====================================================================
#  Ручной деплой образов procure-ai в GHCR — БЕЗ GitHub Actions (путь B). Windows-аналог .sh.
#  Собирает и пушит образы app + mcp в ghcr.io. На проде Watchtower подхватит :latest
#  (~5 мин), либо форсни `make prod-redeploy`.
#
#  Нужен Docker Desktop + PAT со scope write:packages (read:packages).
#
#  Запуск:
#    $env:GHCR_TOKEN="ghp_xxx"; powershell -ExecutionPolicy Bypass -File scripts\deploy-images.ps1
#
#  Параметры (env): GHCR_TOKEN, OWNER (=postroyka), GHCR_USER (=OWNER),
#                   IMAGES ("app mcp"), PUSH (1 пушить | 0 только собрать).
#  Скопируйте весь вывод и пришлите при проблемах.
# =====================================================================
$ErrorActionPreference = "Stop"

$Owner    = if ($env:OWNER) { $env:OWNER } else { "postroyka" }
$GhcrUser = if ($env:GHCR_USER) { $env:GHCR_USER } else { $Owner }
$Images   = if ($env:IMAGES) { $env:IMAGES -split '\s+' } else { @("app", "mcp") }
$Push     = if ($null -ne $env:PUSH) { $env:PUSH } else { "1" }

# Корень репо = на уровень выше каталога скрипта (Docker-контекст = корень репозитория).
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host "[FAIL] docker не найден в PATH"; exit 1 }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] Docker-демон недоступен — запусти Docker Desktop и повтори"; exit 1 }

$Sha = (git rev-parse HEAD 2>$null)
if (-not $Sha) { $Sha = "unknown" }
Write-Host "Деплой образов procure-ai -> ghcr.io/$Owner"
Write-Host "Коммит: $Sha"
Write-Host ("Образы: {0} | PUSH={1}" -f ($Images -join ' '), $Push)
Write-Host "---------------------------------------------"

# Логин в GHCR, если передан токен; иначе считаем, что docker login уже выполнен.
if ($env:GHCR_TOKEN) {
  $env:GHCR_TOKEN | docker login ghcr.io -u $GhcrUser --password-stdin
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] docker login не удался"; exit 1 }
}

foreach ($name in $Images) {
  switch ($name) {
    "app" { $dockerfile = "Dockerfile.app" }
    "mcp" { $dockerfile = "Dockerfile.mcp" }
    default { Write-Host "[FAIL] неизвестный образ '$name' (ожидается app|mcp)"; exit 1 }
  }
  $repo = "ghcr.io/$Owner/procure-ai-$name"
  Write-Host ">>> build ${repo} (:latest, :sha-$Sha) <- $dockerfile"
  & docker build -f $dockerfile -t "${repo}:latest" -t "${repo}:sha-$Sha" .
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] build $name не удался"; exit 1 }
  if ($Push -eq "1") {
    & docker push "${repo}:latest"
    & docker push "${repo}:sha-$Sha"
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] push $name не удался"; exit 1 }
  }
}

Write-Host "---------------------------------------------"
if ($Push -eq "1") {
  Write-Host "[OK] образы собраны и запушены в GHCR."
  Write-Host "Накат на сервере: make prod-redeploy   (или подождать Watchtower ~5 мин)"
} else {
  Write-Host "[OK] образы собраны (PUSH=0 — без пуша)."
}
