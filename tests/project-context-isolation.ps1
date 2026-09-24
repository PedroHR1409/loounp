#Requires -Version 5.1
<#
.SYNOPSIS
  Gate 0: suíte nativa de isolamento do worker (integridade baixa + Job Object).
.DESCRIPTION
  Executa somente contra uma raiz descartável criada em %TEMP% (nunca contra Projetos),
  usando o runtime real e o lançador real. Não exige administrador.
  1. Sonda em integridade baixa tenta criar, editar, truncar, excluir, renomear, criar pasta,
     alterar atributos e ACL, criar junction e gravar por processo filho; depois do guarda,
     tenta rede e novos processos. Tudo deve ser bloqueado.
  2. Encerrar apenas o processo do lançador deve encerrar o worker (Job Object).
  3. O worker real cataloga o fixture pelo protocolo v1, sem vazar o segredo sintético.
  4. O snapshot do fixture (conteúdo, atributos, datas, ACL) deve permanecer idêntico.
  Saída: 0 aprovado (grava gate-approval.json), 1 reprovado, 2 bloqueado.
#>
param(
  [string] $RuntimeDirectory = (Join-Path $env:APPDATA 'content-discovery-poc\article-to-project\runtime'),
  [string] $FeatureDirectory = (Join-Path $env:APPDATA 'content-discovery-poc\article-to-project'),
  [Parameter(Mandatory)] [ValidatePattern('^[a-f0-9]{64}$')] [string] $PolicySha256,
  [string] $ProtectedRoot = (Join-Path $env:USERPROFILE 'Desktop\Projetos'),
  [int] $TimeoutSeconds = 180
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$suiteVersion = 'gate0-v2'

function Test-Inside([string] $Child, [string] $Parent) {
  $c = [IO.Path]::GetFullPath($Child).TrimEnd('\'); $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  $c.Equals($p, 'OrdinalIgnoreCase') -or $c.StartsWith("$p\", [StringComparison]::OrdinalIgnoreCase)
}

$manifest = Join-Path $RuntimeDirectory 'runtime-manifest.json'
$python = Join-Path $RuntimeDirectory 'venv\Scripts\python.exe'
$workerDir = Join-Path $RuntimeDirectory 'worker'
$launcher = Join-Path $workerDir 'lowil_launcher.py'
foreach ($required in @($manifest, $python, $launcher, (Join-Path $workerDir 'worker.py'))) {
  if (-not (Test-Path -LiteralPath $required)) { Write-Output "BLOCKED: runtime incompleto ($required). Execute scripts/package-project-context.ps1."; exit 2 }
}
$localLow = Join-Path $env:USERPROFILE 'AppData\LocalLow'
if (-not (Test-Path -LiteralPath $localLow)) { Write-Output 'BLOCKED: AppData\LocalLow não existe.'; exit 2 }
$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName
foreach ($path in @($RuntimeDirectory, $FeatureDirectory, $localLow, $tempRoot)) { if (Test-Inside $path $ProtectedRoot) { Write-Output "BLOCKED: $path está dentro de Projetos."; exit 2 } }

$id = [Guid]::NewGuid().ToString('N')
$work = Join-Path $tempRoot "a2p-gate0-$id"
$fixture = Join-Path $work 'fixture'; $inputDir = Join-Path $work 'input'
$low = Join-Path $localLow "content-discovery-poc\article-to-project\gate0\$id"
New-Item -ItemType Directory -Path "$fixture\demo\src", $inputDir | Out-Null
Set-Content -LiteralPath "$fixture\demo\README.md" -Value "# Demo`n`nProjeto fictício para o Gate 0 com busca BM25." -Encoding utf8
Set-Content -LiteralPath "$fixture\demo\src\app.py" -Value "def main():`n    return 1" -Encoding utf8
Set-Content -LiteralPath "$fixture\demo\.env" -Value 'API_KEY="sk-gate0-abcdefghijklmnopqrstuv"' -Encoding utf8
Set-Content -LiteralPath "$fixture\demo\config.py" -Value 'token = "sk-gate0-abcdefghijklmnopqrstuv"' -Encoding utf8
Set-Content -LiteralPath "$fixture\demo\setup.ps1" -Value "New-Item $fixture\pwned.txt" -Encoding utf8

function Get-Snapshot([string] $Root) {
  $Root = (Get-Item -LiteralPath $Root).FullName
  Get-ChildItem -LiteralPath $Root -Recurse -Force | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{
      Path = $_.FullName.Substring($Root.Length); Attributes = [string]$_.Attributes; LastWrite = if ($_.PSIsContainer) { 0 } else { $_.LastWriteTimeUtc.Ticks }
      Hash = if ($_.PSIsContainer) { '' } else { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
      Acl = (Get-Acl -LiteralPath $_.FullName).Sddl
    }
  } | ConvertTo-Json -Depth 3
}
Start-Sleep -Seconds 1
$before = Get-Snapshot $fixture
$failures = New-Object System.Collections.Generic.List[string]

$probe = @'
import json, os, subprocess, sys, time
source, report, guard_dir = sys.argv[1], sys.argv[2], sys.argv[3]
target = os.path.join(source, "demo", "README.md")
results = {"pid": os.getpid()}
def attempt(name, op):
    try:
        op(); results[name] = "SUCCEEDED"
    except Exception as error:
        results[name] = "blocked: " + type(error).__name__
try:
    results["read"] = "ok" if "Gate 0" in open(target, encoding="utf-8-sig").read() else "wrong content"
except Exception as error:
    results["read"] = "FAIL " + type(error).__name__
attempt("create", lambda: open(os.path.join(source, "demo", "new.txt"), "w").write("x"))
attempt("edit", lambda: open(target, "a").write("x"))
attempt("truncate", lambda: open(target, "w").close())
attempt("delete", lambda: os.remove(target))
attempt("rename", lambda: os.rename(target, target + ".moved"))
attempt("move", lambda: os.replace(os.path.join(source, "demo", "src", "app.py"), os.path.join(source, "app.py")))
attempt("mkdir", lambda: os.mkdir(os.path.join(source, "demo", "d")))
attempt("attributes", lambda: os.chmod(target, 0o444))
attempt("child_write", lambda: subprocess.run(["cmd", "/c", "echo x> " + os.path.join(source, "demo", "child.txt")], check=True, capture_output=True))
attempt("icacls", lambda: subprocess.run(["icacls", target, "/deny", "Everyone:R"], check=True, capture_output=True))
attempt("junction", lambda: subprocess.run(["cmd", "/c", "mklink", "/J", os.path.join(source, "demo", "j"), os.environ["SYSTEMROOT"]], check=True, capture_output=True))
sys.path.insert(0, guard_dir)
import sandbox_guard
sandbox_guard.install()
import socket
attempt("network", lambda: socket.create_connection(("example.com", 443), timeout=5))
attempt("process_after_guard", lambda: subprocess.run(["cmd", "/c", "echo"], check=True))
os.makedirs(os.path.dirname(report), exist_ok=True)
open(report, "w", encoding="utf-8").write(json.dumps(results))
if len(sys.argv) > 4:
    time.sleep(float(sys.argv[4]))
'@
$probePath = Join-Path $work 'probe.py'
Set-Content -LiteralPath $probePath -Value $probe -Encoding ascii

function Invoke-Low([string] $Entry, [string] $Workdir, [string[]] $Arguments) {
  $all = @('-I', $launcher, '--python', $python, '--entry', $Entry, '--workdir', $Workdir, '--') + $Arguments
  & $python @all | Out-Null
  $LASTEXITCODE
}

try {
  $probeReport = Join-Path $low 'probe\exchange\report.json'
  $code = Invoke-Low $probePath (Join-Path $low 'probe') @($fixture, $probeReport, $workerDir)
  if ($code -ne 0) { $failures.Add("Sonda terminou com código $code (91 = processo não estava em integridade baixa).") }
  if (Test-Path -LiteralPath $probeReport) {
    $result = Get-Content -LiteralPath $probeReport -Raw | ConvertFrom-Json
    if ($result.read -ne 'ok') { $failures.Add("Leitura do fixture falhou: $($result.read)") }
    foreach ($name in 'create', 'edit', 'truncate', 'delete', 'rename', 'move', 'mkdir', 'attributes', 'child_write', 'icacls', 'junction', 'network', 'process_after_guard') {
      $value = [string]$result.$name
      if (-not $value.StartsWith('blocked')) { $failures.Add("Tentativa '$name' não foi bloqueada ($value).") } else { Write-Output "  $name -> $value" }
    }
  } else { $failures.Add('Sonda não publicou resultado.') }

  $killReport = Join-Path $low 'kill\exchange\report.json'
  $killArgs = @('-I', $launcher, '--python', $python, '--entry', $probePath, '--workdir', (Join-Path $low 'kill'), '--', $fixture, $killReport, $workerDir, '120')
  $quoted = $killArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
  $process = Start-Process -FilePath $python -ArgumentList $quoted -PassThru -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path -LiteralPath $killReport) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (Test-Path -LiteralPath $killReport) {
    $workerPid = (Get-Content -LiteralPath $killReport -Raw | ConvertFrom-Json).pid
    Stop-Process -Id $process.Id -Force
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Process -Id $workerPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $workerPid -ErrorAction SilentlyContinue) { $failures.Add('Worker sobreviveu ao encerramento do lançador.'); Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue }
    else { Write-Output '  kill_on_close -> worker encerrado com o lançador' }
  } else { $failures.Add('Teste de encerramento não iniciou.'); Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }

  $exchange = Join-Path $low 'job\exchange'
  New-Item -ItemType Directory -Force -Path $exchange | Out-Null
  Set-Content -LiteralPath "$inputDir\request.json" -Value '{"contract":"v1","jobId":"job_gate0suite","seq":1,"op":"catalog","params":{}}' -Encoding ascii
  $code = Invoke-Low (Join-Path $workerDir 'worker.py') (Join-Path $low 'job') @('--input', $inputDir, '--exchange', $exchange, '--source', $fixture)
  if ($code -ne 0) {
    $detail = if (Test-Path -LiteralPath "$exchange\status.json") { (Get-Content -LiteralPath "$exchange\status.json" -Raw) } else { 'sem status.json' }
    $failures.Add("Worker terminou com código $code ($detail).")
  }
  if (Test-Path -LiteralPath "$exchange\response.json") {
    $response = Get-Content -LiteralPath "$exchange\response.json" -Raw | ConvertFrom-Json
    if ($response.jobId -ne 'job_gate0suite' -or $response.contract -ne 'v1') { $failures.Add('Resposta do worker fora do protocolo.') }
    $all = (Get-ChildItem -LiteralPath $exchange -Filter '*.json' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join ''
    if ($all -match 'sk-gate0') { $failures.Add('Segredo sintético apareceu no intercâmbio.') }
    if ($all -notmatch 'demo/README.md') { $failures.Add('README do fixture não foi catalogado.') }
    $graph = ($all | Select-String -Pattern '"graph":\s*\{"status":\s*"([a-z_]+)"' -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value }
    Write-Output "  worker -> estado $($response.state); grafo: $($graph -join ', ')"
  } else { $failures.Add('Worker não publicou response.json.') }

  $after = Get-Snapshot $fixture
  if ($after -ne $before) {
    $changes = Compare-Object @($before | ConvertFrom-Json) @($after | ConvertFrom-Json) -Property Path, Attributes, LastWrite, Hash, Acl | ForEach-Object { "$($_.SideIndicator) $($_.Path) attr=$($_.Attributes) write=$($_.LastWrite)" }
    $failures.Add("Snapshot do fixture mudou: $($changes -join ' | ')")
  }
  if (Test-Path -LiteralPath (Join-Path $work 'pwned.txt')) { $failures.Add('Script do fixture foi executado.') }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $low -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) { Write-Output 'FAILED:'; $failures | ForEach-Object { Write-Output " - $_" }; exit 1 }
$approval = [ordered]@{
  suiteVersion = $suiteVersion; runtimeSha256 = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
  adapterVersion = 'graphify-adapter-v1'; policySha256 = $PolicySha256; approvedAt = (Get-Date).ToUniversalTime().ToString('o')
}
New-Item -ItemType Directory -Force -Path $FeatureDirectory | Out-Null
$approval | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $FeatureDirectory 'gate-approval.json') -Encoding ascii
Write-Output 'PASSED: Gate 0 aprovado para este runtime e política.'
exit 0
