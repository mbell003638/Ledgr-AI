$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker Desktop is required. Install it from https://docs.docker.com/desktop/ and run this installer again.'
  exit 1
}

New-Item -ItemType Directory -Force -Path 'secrets' | Out-Null
function New-SecretFile([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes) | Set-Content -NoNewline -LiteralPath $Path
  }
}
New-SecretFile 'secrets/postgres_password'
New-SecretFile 'secrets/metrics_token'
if (-not (Test-Path -LiteralPath 'secrets/database_url')) {
  $password = (Get-Content -Raw -LiteralPath 'secrets/postgres_password').Trim()
  "postgres://ledgr_sync:$password@postgres:5432/ledgr_sync" | Set-Content -NoNewline -LiteralPath 'secrets/database_url'
}
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host 'Created .env. Set the server domain and OIDC values, then run this installer again.'
  exit 0
}

docker compose pull
docker compose up -d
$domain = ((Get-Content -LiteralPath '.env') | Where-Object { $_ -like 'SYNC_DOMAIN=*' }) -replace '^SYNC_DOMAIN=', ''
Write-Host "Ledgr self-host services are running. Check https://$domain/healthz"
