<#
.SYNOPSIS
    Open the inbound ports RFDeck needs. Run as Administrator.

.DESCRIPTION
    The desktop build adds these rules itself at startup. A headless server does
    not, so this script covers that case.

    Only TCP 3000 is obvious. The three UDP ports are where deployments go
    wrong: with them blocked, devices are discovered but never report telemetry,
    which presents as broken hardware rather than as a firewall problem.

.EXAMPLE
    .\scripts\open-firewall.ps1

.EXAMPLE
    .\scripts\open-firewall.ps1 -Port 8080

.EXAMPLE
    .\scripts\open-firewall.ps1 -Remove
    Remove the rules again.
#>
[CmdletBinding()]
param(
    [int]    $Port = 3000,
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "This script must run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell -> Run as Administrator, then re-run." -ForegroundColor Yellow
    exit 1
}

$rules = @(
    @{ Name = 'RFDeck HTTP';  Protocol = 'TCP'; Port = $Port; Note = 'API, frontend, realtime socket' },
    @{ Name = 'RFDeck MCP';   Protocol = 'UDP'; Port = 53212; Note = 'Sennheiser G3/G4 discovery and telemetry' },
    @{ Name = 'RFDeck mDNS';  Protocol = 'UDP'; Port = 5353;  Note = 'EW-DX discovery' },
    @{ Name = 'RFDeck SSCv1'; Protocol = 'UDP'; Port = 45;    Note = 'EW-DX live telemetry' }
)

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue

    if ($Remove) {
        if ($existing) {
            Remove-NetFirewallRule -DisplayName $rule.Name
            Write-Host "removed  $($rule.Name)" -ForegroundColor Yellow
        }
        continue
    }

    if ($existing) {
        Write-Host "exists   $($rule.Name) ($($rule.Protocol) $($rule.Port))" -ForegroundColor DarkGray
        continue
    }

    New-NetFirewallRule -DisplayName $rule.Name `
        -Direction Inbound -Protocol $rule.Protocol -LocalPort $rule.Port `
        -Action Allow -Profile Any | Out-Null
    Write-Host "added    $($rule.Name) ($($rule.Protocol) $($rule.Port)) — $($rule.Note)" -ForegroundColor Green
}

if (-not $Remove) {
    Write-Host ""
    Write-Host "EW-DX telemetry note:" -ForegroundColor Cyan
    Write-Host "  Some EW-DX firmware replies on the ephemeral source port rather than a"
    Write-Host "  fixed one, so a port rule is not always enough. If receivers connect but"
    Write-Host "  never show levels, add an application rule for the node executable:"
    Write-Host ""
    Write-Host "    New-NetFirewallRule -DisplayName 'RFDeck Node Server' ``" -ForegroundColor DarkGray
    Write-Host "      -Direction Inbound -Program (Get-Command node).Source ``" -ForegroundColor DarkGray
    Write-Host "      -Protocol UDP -Action Allow -Profile Any" -ForegroundColor DarkGray
}
