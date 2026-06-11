$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$botDir = Join-Path $repoRoot 'bot'

if (-not (Test-Path (Join-Path $botDir 'node_modules'))) {
  Push-Location $botDir
  try {
    npm install
  } finally {
    Pop-Location
  }
}

Push-Location $botDir
try {
  npm start
} finally {
  Pop-Location
}
