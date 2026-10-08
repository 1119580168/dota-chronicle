[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ClientRoot,
    [string]$ManifestPath = (Join-Path $PSScriptRoot 'version-manifest.json')
)
$ErrorActionPreference = 'Stop'
$ClientRoot = (Resolve-Path -LiteralPath $ClientRoot).Path
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    if ($file.path -match '(^/|:|\.\.)') { throw 'Unsafe manifest path.' }
    $path = Join-Path $ClientRoot $file.path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $($file.path)" }
    if ((Get-Item -LiteralPath $path).Length -ne $file.length) { throw "Size mismatch: $($file.path)" }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) {
        throw "Version/hash mismatch: $($file.path)"
    }
}
"Verified $($manifest.files.Count) critical files: $($manifest.label). This does not verify all base-game VPK payloads."
