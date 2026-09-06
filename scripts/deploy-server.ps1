<#
.SYNOPSIS
    Provision an RFDeck server for testing.

.DESCRIPTION
    Builds the workspace, applies the database schema, and starts the server.
    Safe to re-run: it will not overwrite an existing database.

.EXAMPLE
    .\scripts\deploy-server.ps1
    Build, migrate, and start on port 3000.

.EXAMPLE
    .\scripts\deploy-server.ps1 -Port 8080 -DataDir D:\rfdeck
    Serve on 8080 and keep the database on another drive.

.EXAMPLE
    .\scripts\deploy-server.ps1 -NoStart
    Build and migrate without starting, for a service install.

.EXAMPLE
    .\scripts\deploy-server.ps1 -Check
    Verify prerequisites and exit.
#>
[CmdletBinding()]
param(
    [int]    $Port = 3000,
    [string] $DataDir,
    [switch] $NoStart,
    [switch] $Check,
    # Answer yes in advance to a schema change that drops data. Interactively
    # the schema step asks instead.
    [switch] $AcceptDataLoss
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $RepoRoot 'apps\server'
if (-not $DataDir) { $DataDir = $ServerDir }

function Write-Info { param($m) Write-Host "==> " -ForegroundColor Cyan   -NoNewline; Write-Host $m }
function Write-Ok   { param($m) Write-Host "ok  " -ForegroundColor Green  -NoNewline; Write-Host $m }
function Write-Warn { param($m) Write-Host "!   " -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Write-Fail { param($m) Write-Host "x   " -ForegroundColor Red    -NoNewline; Write-Host $m; exit 1 }

# Run a native command and judge it by its exit code alone.
#
# Windows PowerShell 5.1 turns anything a native executable writes to stderr
# into an ErrorRecord, which under ErrorActionPreference='Stop' aborts the
# script. Both pnpm and Prisma write progress and update notices to stderr while
# succeeding, so without this a perfectly good build fails.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]   $FailureMessage,
        [Parameter(Mandatory)][string[]] $Arguments,
        [switch] $Quiet
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) { & pnpm @Arguments 2>&1 | Out-Null }
        else        { & pnpm @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Null }
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { Write-Fail $FailureMessage }
}

# ── Prerequisites ────────────────────────────────────────────────────────────

Write-Info "Checking prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js is not installed. RFDeck needs Node 24 LTS."
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    Write-Fail "Node $nodeMajor is too old. Install Node 24 LTS."
} elseif ($nodeMajor -lt 24) {
    Write-Warn "Node $nodeMajor detected; 24 LTS is what RFDeck is tested against."
} else {
    Write-Ok "Node $(node -v)"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Fail "pnpm is not installed. Try: npm install -g pnpm"
}
Write-Ok "pnpm $(pnpm -v)"

# A running instance holds the Prisma query engine DLL, which makes
# `prisma generate` fail with EPERM. Catch it here with a clear message rather
# than letting the build die confusingly later.
if (Get-Process RFDeck -ErrorAction SilentlyContinue) {
    Write-Warn "RFDeck is running. Close it first or prisma generate will fail with EPERM."
}

if ($Check) {
    Write-Info "Prerequisites satisfied. Re-run without -Check to deploy."
    exit 0
}

# ── Build ────────────────────────────────────────────────────────────────────

Set-Location $RepoRoot

Write-Info "Installing dependencies"
Invoke-Native -FailureMessage "pnpm install failed" -Quiet -Arguments @('install')

Write-Info "Generating the Prisma client"
Invoke-Native -Quiet `
    -FailureMessage "prisma generate failed. If RFDeck is running, close it and re-run." `
    -Arguments @('--filter', '@rfdeck/server', 'exec', 'prisma', 'generate')

Write-Info "Building"
Invoke-Native -Quiet -FailureMessage "shared-types build failed" -Arguments @('--filter', '@rfdeck/shared-types', 'build')
Invoke-Native -Quiet -FailureMessage "web build failed"          -Arguments @('--filter', '@rfdeck/web', 'build')
Invoke-Native -Quiet -FailureMessage "server build failed"       -Arguments @('--filter', '@rfdeck/server', 'build')
Write-Ok "Build complete"

# ── Database ─────────────────────────────────────────────────────────────────

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force $DataDir | Out-Null }
$DbPath = Join-Path (Resolve-Path $DataDir) 'rfdeck.db'
# Prisma wants a URL, and backslashes are not valid in one.
$env:DATABASE_URL = "file:$($DbPath -replace '\\','/')"

$existed = Test-Path $DbPath
if ($existed) {
    Write-Info "Using existing database at $DbPath"
} else {
    Write-Info "Creating database at $DbPath"
}

# Usually additive — new tables and columns, nothing touched — so re-running
# after a schema change is the intended upgrade path. A release that also
# REMOVES one makes prisma stop and ask for confirmation, which in a script
# reads as a hang. The output is captured and the question asked here instead,
# naming what would be lost and defaulting to no.
$schemaArgs = @('--filter', '@rfdeck/server', 'exec', 'prisma', 'db', 'push', '--skip-generate')
$pushOutput = & pnpm @schemaArgs 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) {
    if ($pushOutput -match 'accept-data-loss|cannot be executed|data will be lost') {
        Write-Host ""
        Write-Host "!   This release needs to remove data from the database." -ForegroundColor Yellow
        Write-Host ""
        $pushOutput | Where-Object { $_ -match '^\s*[•*-]\s' } | ForEach-Object { Write-Host "    $($_.Trim())" }
        Write-Host ""
        $accepted = $AcceptDataLoss.IsPresent
        if (-not $accepted) {
            # A non-interactive host has nobody to ask, and must not decide on
            # its own that data is expendable.
            if ([Environment]::UserInteractive) {
                $accepted = (Read-Host "  Apply it? [y/N]") -match '^(y|yes)$'
            } else {
                Write-Host "!   Not running interactively - refusing." -ForegroundColor Yellow
            }
        }
        if (-not $accepted) {
            Write-Fail "Schema change declined. Nothing was changed. Re-run with -AcceptDataLoss to allow it."
        }
        Invoke-Native -Quiet -FailureMessage "Applying the database schema failed" `
            -Arguments ($schemaArgs + '--accept-data-loss')
    } else {
        $pushOutput | ForEach-Object { Write-Host $_ }
        Write-Fail "Applying the database schema failed"
    }
}
Write-Ok $(if ($existed) { "Schema up to date" } else { "Database created" })

# ── Firewall ─────────────────────────────────────────────────────────────────
#
# Discovery and telemetry use UDP ports beyond the HTTP port. Blocked, devices
# are discovered but never report data — which looks exactly like broken
# hardware, so it is worth being loud about.

Write-Info "Required inbound ports"
Write-Host "    TCP  $Port    HTTP API, frontend, and realtime socket"
Write-Host "    UDP  53212   Sennheiser MCP (G3/G4 discovery and telemetry)"
Write-Host "    UDP  5353    mDNS / Bonjour (EW-DX discovery)"
Write-Host "    UDP  45      SSCv1 (EW-DX live telemetry)"

$missing = @()
foreach ($rule in @(
    @{ Name = 'RFDeck HTTP';  Port = $Port  },
    @{ Name = 'RFDeck MCP';   Port = 53212 },
    @{ Name = 'RFDeck mDNS';  Port = 5353  },
    @{ Name = 'RFDeck SSCv1'; Port = 45    }
)) {
    if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
        $missing += $rule.Name
    }
}
if ($missing.Count -gt 0) {
    Write-Warn "Firewall rules missing: $($missing -join ', ')"
    Write-Warn "Run scripts\open-firewall.ps1 as Administrator to add them."
} else {
    Write-Ok "Firewall rules present"
}

# ── Start ────────────────────────────────────────────────────────────────────

if ($NoStart) {
    Write-Info "Build and database ready. Start with:"
    Write-Host "    cd $ServerDir"
    Write-Host "    `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:PORT='$Port'; node dist\server.js"
    exit 0
}

$env:PORT = "$Port"
Write-Info "Starting RFDeck on port $Port"
Write-Host ""
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "    http://$($_.IPAddress):$Port" }
Write-Host "    http://localhost:$Port"
Write-Host ""
Write-Info "Access is open to the network by default."
Write-Info "To require a PIN: Settings -> Remote Access, on this machine."
Write-Host ""

Set-Location $ServerDir
node dist\server.js
