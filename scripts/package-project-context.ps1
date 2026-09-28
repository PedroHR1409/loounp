#Requires -Version 5.1
<#
.SYNOPSIS
  Prepara o runtime do worker de contexto de projetos com o Python já instalado.
.DESCRIPTION
  Copia a instalação base do Python para o runtime fora da pasta Projetos,
  instala somente as wheels do requirements.lock com --require-hashes, copia o
  worker e gera runtime-manifest.json. Não exige administrador nem executa nada
  dos projetos.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string] $HostPython = 'python',
  [string] $Destination = (Join-Path $env:APPDATA 'content-discovery-poc\article-to-project\runtime'),
  [string] $ProtectedRoot = (Join-Path $env:USERPROFILE 'Desktop\Projetos')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-Full([string] $Path) { [System.IO.Path]::GetFullPath($Path).TrimEnd('\') }

function Assert-External([string] $Path) {
  $full = Resolve-Full $Path
  $root = Resolve-Full $ProtectedRoot
  if ($full.Equals($root, 'OrdinalIgnoreCase') -or $full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { throw "Destino dentro da pasta protegida: $full" }
  $current = $full
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Redirecionamento recusado: $current" }
    }
    $parent = Split-Path -Parent $current
    if ($parent -eq $current) { break }
    $current = $parent
  }
  $full
}

function Get-Sha256([string] $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$workerSource = Join-Path $PSScriptRoot '..\workers\project-context'
$lock = Join-Path $workerSource 'requirements.lock'
$target = Assert-External $Destination
$staging = Assert-External "$target.staging"

$pythonPath = (Get-Command $HostPython -ErrorAction Stop).Source
$info = & $pythonPath -I -c "import sys, platform; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3]); print(platform.machine())"
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível executar o Python informado.' }
$baseExecutable, $version, $machine = $info
if ([version]$version -lt [version]'3.10') { throw "Python $version não suportado (mínimo 3.10)." }
if ($machine -ne 'AMD64') { throw "Arquitetura $machine não corresponde ao lock (win_amd64)." }
$lockTag = (Select-String -LiteralPath $lock -Pattern 'CPython (\d+\.\d+)').Matches[0].Groups[1].Value
if (-not $version.StartsWith("$lockTag.")) { throw "O lock foi resolvido para CPython $lockTag, mas o Python informado é $version. Regenere o lock." }
$basePrefix = & $baseExecutable -I -c "import sys; print(sys.base_prefix)"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $basePrefix -PathType Container)) { throw 'Não foi possível localizar os arquivos base do Python.' }

if (-not $PSCmdlet.ShouldProcess($target, "Criar runtime com Python $version")) { return }
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path "$staging\worker" | Out-Null
New-Item -ItemType Directory -Path "$staging\python-base" | Out-Null
Get-ChildItem -LiteralPath $basePrefix -Force | Copy-Item -Destination "$staging\python-base" -Recurse -Force
& "$staging\python-base\python.exe" -I -m venv --copies "$staging\venv"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o ambiente virtual.' }
& "$staging\venv\Scripts\python.exe" -I -m pip install --no-deps --require-hashes --only-binary=:all: --no-compile --disable-pip-version-check --no-input -r $lock
if ($LASTEXITCODE -ne 0) { throw 'Instalação com hashes falhou.' }
foreach ($file in 'worker.py', 'graphify_adapter.py', 'sandbox_guard.py', 'lowil_launcher.py') { Copy-Item -LiteralPath (Join-Path $workerSource $file) -Destination "$staging\worker" }

if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Move-Item -LiteralPath $staging -Destination $target
$venvConfig = Join-Path $target 'venv\pyvenv.cfg'
$configText = Get-Content -LiteralPath $venvConfig -Raw
$configText = $configText.Replace($staging, $target)
$configText = [regex]::Replace($configText, '(?m)^home\s*=\s*.*$', "home = $(Join-Path $target 'python-base')")
$configText = [regex]::Replace($configText, '(?m)^executable\s*=\s*.*$', "executable = $(Join-Path $target 'python-base\python.exe')")
Set-Content -LiteralPath $venvConfig -Value $configText -NoNewline -Encoding ascii
$runtimeBase = & "$target\venv\Scripts\python.exe" -I -c "import sys; print(sys.base_prefix)"
if ($LASTEXITCODE -ne 0 -or (Resolve-Full $runtimeBase) -ne (Resolve-Full (Join-Path $target 'python-base'))) { throw 'O Python empacotado não resolveu a base dentro do runtime.' }
& (Join-Path $env:SYSTEMROOT 'System32\icacls.exe') $target /grant '*S-1-15-2-1:(OI)(CI)(RX)' /Q
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível habilitar leitura do runtime para AppContainer.' }
$files = Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.FullName -notmatch '\\__pycache__\\' -and $_.Name -ne 'runtime-manifest.json' } | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($target.Length + 1).Replace('\', '/'); sha256 = Get-Sha256 $_.FullName; bytes = $_.Length }
}
$manifest = [ordered]@{
  contract = 'v1'; adapter = 'graphify-adapter-v1'; isolation = 'low-integrity-token+appcontainer+job-object'; network = 'appcontainer-no-capabilities+python-audit-hook'; processes = 'fixed-graphify-invocation-only'
  python = [ordered]@{ version = $version; executable = (Join-Path $target 'python-base\python.exe'); sha256 = Get-Sha256 (Join-Path $target 'python-base\python.exe') }
  lock = Get-Sha256 $lock; files = @($files)
}
$manifest | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath "$target\runtime-manifest.json" -Encoding ascii
Write-Output "Runtime criado em $target com Python $version ($baseExecutable)"
Write-Output "SHA-256 do manifesto: $(Get-Sha256 "$target\runtime-manifest.json")"
