<#
  register_auto_trader_task.ps1
  Registers (or re-registers) a Windows Task Scheduler job that runs the
  TradingView paper auto-trader once every 15 minutes, in the background,
  whether or not any Claude / terminal session is open.

  Run it in a NORMAL (non-admin) PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\register_auto_trader_task.ps1

  Remove it later with:
      Unregister-ScheduledTask -TaskName "TradingViewAutoTrader" -Confirm:$false

  Notes:
   - The task runs only while YOU are logged in (-LogonType Interactive), because
     it needs to reach the TradingView Desktop window you have open on 127.0.0.1:9222.
   - If TradingView isn't running / CDP isn't reachable when it fires, the script
     just logs an error and exits cleanly — no trades, no crash.
   - The runner itself is hard-locked to PAPER_ONLY=true.
#>

$ErrorActionPreference = 'Stop'

$TaskName   = 'TradingViewAutoTrader'
$ProjectDir = Split-Path -Parent $PSScriptRoot      # ...\tradingview-mcp
$BatPath    = Join-Path $PSScriptRoot 'run_auto_trader.bat'

if (-not (Test-Path $BatPath)) { throw "Wrapper not found: $BatPath" }

Write-Host "Project : $ProjectDir"
Write-Host "Wrapper : $BatPath"
Write-Host "Task    : $TaskName (every 15 minutes)"

# Action: run the .bat with the project as working directory.
$action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory $ProjectDir

# Trigger: start ~1 min from now, then repeat every 15 min, effectively forever.
$start   = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# Settings: allow on battery, don't stop if it runs a little long, run hidden.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

# Run as the current interactive user (needs your session + open TradingView).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Replace any existing task with the same name.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'TradingView 15m paper auto-trader (PAPER_ONLY). Runs one cycle every 15 minutes.' | Out-Null

Write-Host ""
Write-Host "Registered. First run at $start, then every 15 minutes." -ForegroundColor Green
Write-Host "Run now to test:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Watch the log:    Get-Content logs\auto_trader.log -Wait -Tail 20"
Write-Host "Remove it:        Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
