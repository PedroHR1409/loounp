#Requires -Version 5.1
<#
.SYNOPSIS
  Prepara o runtime do worker de contexto de projetos com o Python já instalado.
.DESCRIPTION
  Cria um ambiente virtual fora da pasta Projetos, instala somente as wheels do
  requirements.lock com --require-hashes, copia worker, lançador e guarda e gera
  runtime-manifest.json (inclui o hash do executável Python usado). Não exige
  administrador, não altera configurações do Windows e não executa nada dos projetos.
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

if (-not $PSCmdlet.ShouldProcess($target, "Criar runtime com Python $version")) { return }
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path "$staging\worker" | Out-Null
& $baseExecutable -I -m venv "$staging\venv"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o ambiente virtual.' }
& "$staging\venv\Scripts\python.exe" -I -m pip install --no-deps --require-hashes --only-binary=:all: --no-compile --disable-pip-version-check --no-input -r $lock
if ($LASTEXITCODE -ne 0) { throw 'Instalação com hashes falhou.' }
foreach ($file in 'worker.py', 'graphify_adapter.py', 'sandbox_guard.py', 'lowil_launcher.py') { Copy-Item -LiteralPath (Join-Path $workerSource $file) -Destination "$staging\worker" }

if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Move-Item -LiteralPath $staging -Destination $target
$files = Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.FullName -notmatch '\\__pycache__\\' -and $_.Name -ne 'runtime-manifest.json' } | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($target.Length + 1).Replace('\', '/'); sha256 = Get-Sha256 $_.FullName; bytes = $_.Length }
}
$manifest = [ordered]@{
  contract = 'v1'; adapter = 'graphify-adapter-v1'; isolation = 'low-integrity-token+job-object'
  python = [ordered]@{ version = $version; executable = $baseExecutable; sha256 = Get-Sha256 $baseExecutable }
  lock = Get-Sha256 $lock; files = @($files)
}
$manifest | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath "$target\runtime-manifest.json" -Encoding ascii
Write-Output "Runtime criado em $target com Python $version ($baseExecutable)"
Write-Output "SHA-256 do manifesto: $(Get-Sha256 "$target\runtime-manifest.json")"
