param (
    [string]$Token,
    [string[]]$Branches = @("settings-ui-optimized", "settings-ui-simplified", "v3.0")
)

# 1. Read token from .env if not passed explicitly
if (-not $Token -and (Test-Path ".env")) {
    $envContent = Get-Content ".env"
    foreach ($line in $envContent) {
        if ($line -match "^GITHUB_TOKEN=(.+)$") {
            $Token = $matches[1].Trim()
        }
    }
}

if (-not $Token -and $env:GITHUB_TOKEN) {
    $Token = $env:GITHUB_TOKEN
}

if (-not $Token) {
    Write-Error "No GITHUB_TOKEN found! Please save your token in a .env file as GITHUB_TOKEN=ghp_... or pass it via -Token parameter."
    exit 1
}

$repo = "mbell003638/Ledgr-AI"
$workflow = "build-apk.yml"

foreach ($branch in $Branches) {
    Write-Host "Triggering workflow for branch: $branch..." -ForegroundColor Green
    $uri = "https://api.github.com/repos/$repo/actions/workflows/$workflow/dispatches"
    $headers = @{
        "Accept" = "application/vnd.github+json"
        "Authorization" = "Bearer $Token"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "PowerShell-Build-Trigger"
    }
    $body = @{
        "ref" = $branch
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body
        Write-Host "Successfully triggered build for branch '$branch'!" -ForegroundColor Green
    } catch {
        Write-Error "Failed to trigger build for branch '$branch': $_"
    }
}
