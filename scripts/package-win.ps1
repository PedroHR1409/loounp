param(
  [ValidateSet("all", "portable", "nsis")]
  [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Set-Location -LiteralPath $projectRoot

& npm.cmd run build
if ($LASTEXITCODE -ne 0) {
  throw "Build do Loounp falhou com código $LASTEXITCODE."
}

$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$buildId = [guid]::NewGuid().ToString("N")
$buildOut = Join-Path $tempRoot "loounp-win-$buildId"
$configPath = Join-Path $tempRoot "loounp-builder-$buildId.json"
$buildSucceeded = $false

try {
  $package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $package.build.directories.output = $buildOut
  $configJson = $package.build | ConvertTo-Json -Depth 16
  [System.IO.File]::WriteAllText(
    $configPath,
    $configJson,
    [System.Text.UTF8Encoding]::new($false)
  )

  $builder = Join-Path $projectRoot "node_modules\.bin\electron-builder.cmd"
  $builderArgs = if ($Target -eq "all") {
    @("--win", "--x64", "--config", $configPath)
  } else {
    @("--win", $Target, "--x64", "--config", $configPath)
  }
  & $builder @builderArgs
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder falhou com código $LASTEXITCODE."
  }

  $artifacts = @(Get-ChildItem -LiteralPath $buildOut -Filter "*.exe" -File)
  $expectedArtifacts = if ($Target -eq "all") { 2 } else { 1 }
  if ($artifacts.Count -ne $expectedArtifacts) {
    throw "Esperava dois executáveis em $buildOut; encontrei $($artifacts.Count)."
  }

  $releaseRoot = Join-Path $projectRoot "release"
  $buildStamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $release = Join-Path $releaseRoot "build-$buildStamp"
  New-Item -ItemType Directory -Path $release -Force | Out-Null
  foreach ($artifact in $artifacts) {
    Copy-Item -LiteralPath $artifact.FullName -Destination $release -Force
  }
  $extensionOutput = Join-Path $release "chrome-edge-extension"
  New-Item -ItemType Directory -Path $extensionOutput -Force | Out-Null
  Copy-Item -Path (Join-Path $projectRoot "extensions\chrome-edge\*") -Destination $extensionOutput -Recurse -Force

  if ($Target -ne "nsis") {
    $portableArtifacts = @(Get-ChildItem -LiteralPath $release -Filter "*-portable-*.exe" -File)
    if ($portableArtifacts.Count -ne 1) {
      throw "Esperava um executável portable em $release; encontrei $($portableArtifacts.Count)."
    }
    Copy-Item -LiteralPath $portableArtifacts[0].FullName -Destination $releaseRoot -Force
    $rootExtensionOutput = Join-Path $releaseRoot "chrome-edge-extension"
    New-Item -ItemType Directory -Path $rootExtensionOutput -Force | Out-Null
    Copy-Item -Path (Join-Path $extensionOutput "*") -Destination $rootExtensionOutput -Recurse -Force
    Write-Host "Portable atualizado em $releaseRoot"
  }

  $buildSucceeded = $true
  Write-Host "Executáveis criados em $release"
  Get-ChildItem -LiteralPath $release -Filter "*.exe" -File |
    Select-Object Name, Length
}
finally {
  if (Test-Path -LiteralPath $configPath) {
    Remove-Item -LiteralPath $configPath -Force
  }

  if ($buildSucceeded -and (Test-Path -LiteralPath $buildOut)) {
    $resolvedOutput = [System.IO.Path]::GetFullPath(
      (Resolve-Path -LiteralPath $buildOut).Path
    )
    if (
      [System.IO.Path]::GetDirectoryName($resolvedOutput) -ne $tempRoot -or
      [System.IO.Path]::GetFileName($resolvedOutput) -ne "loounp-win-$buildId"
    ) {
      throw "A pasta temporária de build não corresponde ao caminho criado pelo script."
    }
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
  }
}
