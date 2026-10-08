[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string]$Address,
    [ValidateRange(1024,65535)][int]$Port = 30322,
    [Parameter(Mandatory)][string]$Password,
    [ValidateRange(100,10000)][int]$ReadMilliseconds = 1000
)
$ErrorActionPreference = 'Stop'
$connection = [Net.Sockets.TcpClient]::new()
try {
    $pending = $connection.ConnectAsync($Address, $Port)
    if (-not $pending.Wait(3000)) { throw 'RCON connection timed out.' }
    $stream = $connection.GetStream()
    $stream.ReadTimeout = 3000
    function Send-Packet([int]$Id, [int]$Type, [string]$Value) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        $memory = [IO.MemoryStream]::new()
        $writer = [IO.BinaryWriter]::new($memory)
        try {
            $writer.Write([int]($bytes.Length + 10))
            $writer.Write($Id)
            $writer.Write($Type)
            $writer.Write($bytes)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $packet = $memory.ToArray()
            $stream.Write($packet, 0, $packet.Length)
        } finally { $writer.Dispose(); $memory.Dispose() }
    }
    function Read-Exact([int]$Size) {
        $bytes = [byte[]]::new($Size)
        $offset = 0
        while ($offset -lt $Size) {
            $count = $stream.Read($bytes, $offset, $Size - $offset)
            if ($count -eq 0) { throw [IO.EndOfStreamException]::new('RCON closed.') }
            $offset += $count
        }
        return ,$bytes
    }
    function Read-Packet {
        $size = [BitConverter]::ToInt32((Read-Exact 4), 0)
        if ($size -lt 10 -or $size -gt 4MB) { throw 'Invalid RCON packet length.' }
        $bytes = Read-Exact $size
        return [pscustomobject]@{
            id = [BitConverter]::ToInt32($bytes, 0)
            type = [BitConverter]::ToInt32($bytes, 4)
            text = [Text.Encoding]::UTF8.GetString($bytes, 8, $size - 10)
        }
    }
    Send-Packet 101 3 $Password
    $authenticated = $false
    for ($i = 0; $i -lt 3; $i++) {
        $packet = Read-Packet
        if ($packet.type -eq 2) {
            if ($packet.id -ne 101) { throw 'RCON authentication failed.' }
            $authenticated = $true
            break
        }
    }
    if (-not $authenticated) { throw 'Missing RCON authentication response.' }
    Send-Packet 102 2 $Command
    $result = [Text.StringBuilder]::new()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt $ReadMilliseconds) {
        if ($stream.DataAvailable) {
            try { $packet = Read-Packet }
            catch [IO.EndOfStreamException] { break }
            if ($packet.id -eq 102) { [void]$result.Append($packet.text) }
        } else { Start-Sleep -Milliseconds 25 }
    }
    $result.ToString()
} finally { $connection.Dispose() }
