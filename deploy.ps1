[CmdletBinding()]
param(
  [string]$DatabaseName = "rapid-vimnote",
  [string]$DatabaseId = "",
  [switch]$CreateDatabase,
  [switch]$SkipInstall,
  [switch]$SkipSchema,
  [switch]$SkipDeploy,
  [switch]$PrepareGitHub,
  [switch]$GitHubOnly,
  [string]$GitHubRemoteUrl = "",
  [string]$CommitMessage = "Initial rapid-vimnote deploy"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$WranglerConfig = Join-Path $ProjectRoot "wrangler.toml"
$SchemaFile = Join-Path $ProjectRoot "db\schema.sql"

Set-Location -LiteralPath $ProjectRoot

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "No encontre '$Name' en PATH. Instalalo y vuelve a correr este script."
  }
}

function Invoke-Native {
  param(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments
  )

  Write-Step $Label
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Fallo: $FilePath $($Arguments -join ' ')"
  }
}

function Read-Text {
  param([string]$Path)
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Text {
  param(
    [string]$Path,
    [string]$Value
  )

  $encoding = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-ConfiguredDatabaseId {
  if (-not (Test-Path -LiteralPath $WranglerConfig)) {
    throw "No existe wrangler.toml en $ProjectRoot"
  }

  $content = Read-Text $WranglerConfig
  if ($content -match 'database_id\s*=\s*"([^"]+)"') {
    return $Matches[1]
  }

  return ""
}

function Set-ConfiguredDatabaseId {
  param([string]$Id)

  if ($Id -notmatch '^[A-Za-z0-9_-]{8,128}$') {
    throw "database_id parece invalido: $Id"
  }

  $content = Read-Text $WranglerConfig
  if ($content -notmatch 'database_id\s*=') {
    throw "No encontre database_id en wrangler.toml"
  }

  $updated = [regex]::Replace($content, 'database_id\s*=\s*"[^"]+"', "database_id = `"$Id`"", 1)
  Write-Text $WranglerConfig $updated
  Write-Note "wrangler.toml actualizado con database_id=$Id"
}

function New-D1DatabaseAndCaptureId {
  param([string]$Name)

  Write-Step "Creando D1 '$Name'"
  $output = & npx wrangler d1 create $Name 2>&1
  $exitCode = $LASTEXITCODE
  $output | ForEach-Object { Write-Host $_ }

  if ($exitCode -ne 0) {
    throw "No pude crear D1. Si ya existe, corre: .\deploy.ps1 -DatabaseId TU_DATABASE_ID"
  }

  $text = $output | Out-String
  if ($text -match 'database_id\s*=\s*"([^"]+)"') {
    return $Matches[1]
  }

  if ($text -match '"database_id"\s*:\s*"([^"]+)"') {
    return $Matches[1]
  }

  throw "D1 se creo, pero no pude leer el database_id del output. Pegalo manualmente en wrangler.toml."
}

function Ensure-CloudflareLogin {
  Write-Step "Validando sesion de Cloudflare"
  & npx wrangler whoami
  if ($LASTEXITCODE -eq 0) {
    return
  }

  Invoke-Native "Abriendo login de Cloudflare" "npx" @("wrangler", "login")
}

function Ensure-DatabaseId {
  $configuredId = Get-ConfiguredDatabaseId

  if ($DatabaseId) {
    Set-ConfiguredDatabaseId $DatabaseId
    return
  }

  if ($configuredId -and $configuredId -ne "REPLACE_WITH_D1_DATABASE_ID") {
    Write-Note "D1 configurado: $configuredId"
    return
  }

  if (-not $CreateDatabase) {
    Write-Host ""
    $answer = Read-Host "No hay database_id. Crear D1 '$DatabaseName' ahora? [S/n]"
    if ($answer -match '^(n|no)$') {
      $manualId = Read-Host "Pega aqui el database_id de Cloudflare"
      Set-ConfiguredDatabaseId $manualId
      return
    }

    $script:CreateDatabase = $true
  }

  $newId = New-D1DatabaseAndCaptureId $DatabaseName
  Set-ConfiguredDatabaseId $newId
}

function Set-MainBranch {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & git rev-parse --verify HEAD 1>$null 2>$null
    $hasCommit = $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  if ($hasCommit) {
    Invoke-Native "Usando rama main" "git" @("branch", "-M", "main")
  } else {
    Invoke-Native "Configurando rama main" "git" @("symbolic-ref", "HEAD", "refs/heads/main")
  }
}

function Test-GitRemote {
  param([string]$Name)

  $remotes = & git remote
  if ($LASTEXITCODE -ne 0) {
    throw "No pude leer remotes de git."
  }

  return @($remotes) -contains $Name
}

function Prepare-GitHubImport {
  Write-Step "Preparando import desde GitHub"
  Assert-Command "git"

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git"))) {
    Invoke-Native "Inicializando git" "git" @("init")
  }

  Set-MainBranch

  Write-Host ""
  Write-Host "Para subirlo a GitHub:" -ForegroundColor Yellow
  Write-Host "  git add ."
  Write-Host "  git commit -m `"Initial rapid-vimnote deploy`""
  Write-Host "  git remote add origin https://github.com/TU_USUARIO/rapid-vimnote.git"
  Write-Host "  git push -u origin main"
  Write-Host ""
  Write-Host "En Cloudflare Workers & Pages > Create application > Import a repository:" -ForegroundColor Yellow
  Write-Host "  Repository: rapid-vimnote"
  Write-Host "  Production branch: main"
  Write-Host "  Root directory: /"
  Write-Host "  Build command: dejar vacio"
  Write-Host "  Deploy command: npx wrangler deploy"
  Write-Host ""
  Write-Host "Importante: el Worker en Cloudflare debe llamarse igual que name en wrangler.toml: rapid-vimnote"
}

function Publish-GitHubOnly {
  Write-Step "Subiendo proyecto a GitHub"
  Assert-Command "git"

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".git"))) {
    Invoke-Native "Inicializando git" "git" @("init")
  }

  Set-MainBranch

  $remoteUrl = $GitHubRemoteUrl.Trim()
  if (-not $remoteUrl) {
    $remoteUrl = Read-Host "Pega la URL del repo GitHub, ejemplo https://github.com/TU_USUARIO/rapid-vimnote.git"
  }

  if ($remoteUrl -notmatch '^(https://github\.com/[^/]+/[^/]+(\.git)?|git@github\.com:[^/]+/[^/]+(\.git)?)$') {
    throw "URL de GitHub invalida: $remoteUrl"
  }

  if (Test-GitRemote "origin") {
    Invoke-Native "Actualizando remote origin" "git" @("remote", "set-url", "origin", $remoteUrl)
  } else {
    Invoke-Native "Agregando remote origin" "git" @("remote", "add", "origin", $remoteUrl)
  }

  Invoke-Native "Agregando archivos" "git" @("add", ".")

  & git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    Invoke-Native "Creando commit" "git" @("commit", "-m", $CommitMessage)
  } else {
    Write-Note "No hay cambios nuevos para commit."
  }

  Invoke-Native "Subiendo a GitHub" "git" @("push", "-u", "origin", "main")

  Write-Host ""
  Write-Host "Repo listo en GitHub." -ForegroundColor Green
  Write-Host "Ahora puedes importarlo en Cloudflare: Workers & Pages > Create application > Import a repository."
}

Write-Host "Rapid Vimnote deploy" -ForegroundColor Green
Write-Note "Proyecto: $ProjectRoot"

if ($GitHubOnly) {
  Publish-GitHubOnly
  Write-Host ""
  Write-Host "Listo." -ForegroundColor Green
  exit 0
}

Assert-Command "node"
Assert-Command "npm"
Assert-Command "npx"

if (-not (Test-Path -LiteralPath $SchemaFile)) {
  throw "No existe schema D1: $SchemaFile"
}

if (-not $SkipInstall) {
  Invoke-Native "Instalando dependencias" "npm" @("install")
}

Ensure-CloudflareLogin
Ensure-DatabaseId

if (-not $SkipSchema) {
  Invoke-Native "Aplicando schema D1 remoto" "npx" @("wrangler", "d1", "execute", $DatabaseName, "--remote", "--file=./db/schema.sql", "--yes")
}

if (-not $SkipDeploy) {
  Invoke-Native "Publicando Worker + assets" "npx" @("wrangler", "deploy")
}

if ($PrepareGitHub) {
  Prepare-GitHubImport
}

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
