[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientRoot,
    [ValidateSet('Status','FillBots','Stop')][string]$Action = 'Status',
    [Parameter(Mandatory)][string]$StateDirectory
)
$ErrorActionPreference = 'Stop'
$ClientRoot = (Resolve-Path -LiteralPath $ClientRoot).Path
$private = [IO.Path]::GetFullPath($StateDirectory)
$state = Get-Content -LiteralPath (Join-Path $private 'server-state.json') -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
if (-not $process -or $process.ExecutablePath -ne $state.exe -or
    $process.CommandLine -notmatch '(?i)(?:^|\s)-dedicated(?:\s|$)' -or
    [Math]::Abs(($process.CreationDate - [datetime]$state.startTime).TotalSeconds) -gt 2) {
    throw 'Recorded ordinary server not running. No other process was touched.'
}
$password = (Get-Content -LiteralPath (Join-Path $private 'rcon-password.txt') -Raw).Trim()
$send = Join-Path $PSScriptRoot 'invoke-rcon.ps1'
$status = & $send -Address $state.rconAddress -Port $state.port -Password $password -Command 'status' -ReadMilliseconds 500
if ($Action -eq 'Status') { $status; return }
if ($Action -eq 'FillBots') {
    if ($status -notmatch 'GameState:\s*DOTA_GAMERULES_STATE_HERO_SELECTION\b') { throw 'Bot population refused: not at hero selection.' }
    $reply = & $send -Address $state.rconAddress -Port $state.port -Password $password -Command 'sv_cheats 1; script_reload_code codex_old732_standard_fill_bots; sv_cheats 0' -ReadMilliseconds 700
    $reply | Set-Content -LiteralPath (Join-Path $private 'fill-bots.txt') -Encoding UTF8
    if ($reply -notmatch '\[Old732StandardBots\] requested:') { throw "Bot population refused. Inspect $($state.log)" }
    $reply; return
}
. (Join-Path $PSScriptRoot 'standard-status.ps1')
$empty = Test-Old732OrdinaryRoomEmpty $status
if (-not $empty) { throw 'Server has players or unknown status. Stop refused.' }
& $send -Address $state.rconAddress -Port $state.port -Password $password -Command 'quit' -ReadMilliseconds 300 | Out-Null
$timer = [Diagnostics.Stopwatch]::StartNew()
while ($timer.Elapsed.TotalSeconds -lt 15) {
    $alive = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    $udp = @(Get-NetUDPEndpoint -LocalPort $state.port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $state.pid)
    $tcp = @(Get-NetTCPConnection -State Listen -LocalPort $state.port -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $state.pid)
    if (-not $alive -and -not $udp.Count -and -not $tcp.Count) { break }
    Start-Sleep -Milliseconds 150
}
if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) { throw 'Server did not quit. No forced termination performed.' }
'Ordinary server stopped.'
