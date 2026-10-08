[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientRoot,
    [ValidateRange(1024,65535)][int]$Port = 30323,
    [ValidatePattern('^[a-zA-Z0-9_-]{1,64}$')][string]$GamePassword = 'old732-test',
    [switch]$Internet,
    [Parameter(Mandatory)][string]$StateDirectory,
    [ValidatePattern('^(?:\d{1,3}\.){3}\d{1,3}$')][string]$BindAddress = '0.0.0.0',
    [ValidatePattern('^[a-z0-9-]+$')][string]$SessionId = 'room'
)
$ErrorActionPreference = 'Stop'
$ClientRoot = (Resolve-Path -LiteralPath $ClientRoot).Path
& (Join-Path $PSScriptRoot 'verify-client.ps1') -ClientRoot $ClientRoot -ManifestPath (Join-Path $PSScriptRoot 'standard-version-manifest.json')
$exe = Join-Path $ClientRoot 'game/bin/win64/dota2.exe'
$private = [IO.Path]::GetFullPath($StateDirectory)
$statePath = Join-Path $private 'server-state.json'
if (Test-Path -LiteralPath $statePath) {
    $prior = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($prior.pid)"
    if ((Get-Process -Id $prior.pid -ErrorAction SilentlyContinue) -and $existing -and $existing.ExecutablePath -eq $exe -and
        [Math]::Abs(($existing.CreationDate - [datetime]$prior.startTime).TotalSeconds) -lt 2) {
        throw 'The recorded ordinary server is still running. No restart was performed.'
    }
}
if (@(Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue).Count -or
    @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count) {
    throw "Port $Port is already in use."
}
New-Item -ItemType Directory -Path $private -Force | Out-Null
$passwordFile = Join-Path $private 'rcon-password.txt'
if (-not (Test-Path -LiteralPath $passwordFile)) {
    [Guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $passwordFile -Encoding ASCII
}
$rconPassword = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
if ($rconPassword -notmatch '^[a-fA-F0-9]{32}$') { throw 'Invalid private RCON password.' }
foreach ($name in @('standard_setup','standard_fill_bots')) {
    $source = Join-Path $PSScriptRoot ($name + '.lua')
    $destination = Join-Path $ClientRoot ('game/dota/scripts/vscripts/codex_old732_' + $name + '.lua')
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $source).Hash) { throw 'Server helper changed externally; refusing overwrite.' }
    } else { Copy-Item -LiteralPath $source -Destination $destination }
}
$configName = 'chronicle_server_' + $SessionId + '.cfg'
$configFile = Join-Path $ClientRoot ('game/dota/cfg/' + $configName)
@('sv_lan 1', ('sv_password ' + $GamePassword), ('rcon_password ' + $rconPassword),
    'sv_cheats 0', 'sv_hibernate_when_empty 0', 'dota_quit_after_game 0', 'dota_surrender_on_disconnect 0',
    'dota_force_gamemode 1', 'map dota gamemode=1 difficulty=0') | Set-Content -LiteralPath $configFile -Encoding ASCII
$log = Join-Path $private ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-server.log')
$arguments = '-dedicated -console -condebug -ip ' + $BindAddress + ' -con_logfile "' + $log +
    '" -insecure -allow_no_lobby_connect -usercon -port ' + $Port + ' +dev_block_gc_hello +exec ' + $configName
$process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory (Split-Path $exe) -WindowStyle Hidden -PassThru
$state = [ordered]@{ pid=$process.Id; exe=$exe; startTime=$process.StartTime.ToString('o'); port=$Port; log=$log; rconAddress=$null; state='starting'; internet=[bool]$Internet; configFile=$configFile; configSha256=(Get-FileHash -LiteralPath $configFile).Hash }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
$timer = [Diagnostics.Stopwatch]::StartNew()
$endpoint = $null
while ($timer.Elapsed.TotalSeconds -lt 60) {
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { throw "Ordinary server exited. Inspect $log" }
    $endpoint = Get-NetTCPConnection -State Listen -OwningProcess $process.Id -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($endpoint -and (Test-Path -LiteralPath $log) -and (Select-String -LiteralPath $log -Pattern 'CSource2Server::GameServerSteamAPIActivated' -Quiet)) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $endpoint -or $timer.Elapsed.TotalSeconds -ge 60) { throw "Ordinary server not ready. Inspect $log" }
$state.rconAddress = if ($endpoint.LocalAddress -in @('0.0.0.0','::')) { '127.0.0.1' } else { $endpoint.LocalAddress }
$send = Join-Path $PSScriptRoot 'invoke-rcon.ps1'
$reply = & $send -Address $state.rconAddress -Port $Port -Password $rconPassword -Command 'sv_cheats 1; script_reload_code codex_old732_standard_setup; sv_cheats 0' -ReadMilliseconds 800
$reply | Set-Content -LiteralPath (Join-Path $private 'setup-arm.txt') -Encoding UTF8
if ($reply -notmatch '\[Old732StandardSetup\] armed:') { throw "Ordinary setup refused. Inspect $log" }
$lan = if ($Internet) { 0 } else { 1 }
$reply = & $send -Address $state.rconAddress -Port $Port -Password $rconPassword -Command "sv_lan $lan; dota_surrender_on_disconnect; sv_cheats; status" -ReadMilliseconds 500
$reply | Set-Content -LiteralPath (Join-Path $private 'server-at-arm.txt') -Encoding UTF8
$state.state = 'waiting-for-teams'
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
"Ordinary All Pick server PID $($process.Id), UDP $Port; automatic surrender disabled for this private room, hero-selection wait up to 3600 seconds. Cheats=0. Log: $log"
'Players must execute jointeam 2 (Radiant) or jointeam 3 (Dire) after connecting. Fill bots only after human seats are established.'
'Forward only game UDP. Keep private files, server logs and generated server CFG out of player distributions.'
