$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
$taskProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPackage = Get-Content -LiteralPath (Join-Path $taskProject 'package.json') -Raw | ConvertFrom-Json
if ($taskPackage.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$taskRelease = Join-Path $taskProject 'release'
$taskSource = Join-Path $taskRelease 'win-unpacked'
$taskArchive = Join-Path $taskRelease ('Dota-Chronicle-' + $taskPackage.version + '-win-x64.zip')
if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'Dota Chronicle.exe'))) { throw 'Build the Windows directory first.' }
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($taskArchive)) -ne [IO.Path]::GetFullPath($taskRelease)) { throw 'Archive path escaped release folder.' }
if (Test-Path -LiteralPath $taskArchive) { Remove-Item -LiteralPath $taskArchive }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($taskSource, $taskArchive, [IO.Compression.CompressionLevel]::Optimal, $false)
Write-Output $taskArchive
