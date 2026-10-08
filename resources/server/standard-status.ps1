function Test-Old732OrdinaryRoomEmpty([string]$Status) {
    $table = [regex]::Match($Status, '(?s)---------players--------(.*?)GameState:\s*(DOTA_GAMERULES_STATE_\w+)')
    if (-not $table.Success -or $Status -notmatch 'players\s*:\s*\d+ humans,\s*\d+ bots') { return $false }
    $bots = 0
    $noChannels = 0
    foreach ($row in ($table.Groups[1].Value -split '\r?\n' | Where-Object { $_ -match '^\s*\d+\s+' })) {
        if ($row -match '^\s*\d+\s+BOT\s+\d+\s+\d+\s+\S+\s+\d+\s+') {
            $bots++
        } elseif ($row -match '^\s*65535\s+\[NoChan\]\s+\d+\s+\d+\s+reserved\s+') {
            $noChannels++
        } else {
            # A real network channel, or an unknown row format, blocks shutdown.
            return $false
        }
    }
    # Native counts can lag disconnects. BOT rows identify fake clients; the
    # 65535 reserved [NoChan] row has no network channel. An empty table with
    # stale human counts is accepted only after the native match has ended.
    return ($Status -match 'players\s*:\s*0 humans') -or $bots -gt 0 -or $noChannels -gt 0 -or
        $table.Groups[2].Value -in @('DOTA_GAMERULES_STATE_DISCONNECT','DOTA_GAMERULES_STATE_INIT')
}
