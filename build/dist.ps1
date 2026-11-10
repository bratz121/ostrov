# Builds the Windows installer. NSIS can't open files past the 260-character path
# limit, and this project can live deep in AppData, so the build runs from a short
# temporary folder and the finished installer is copied back to dist\.
# Run with: npm run dist   (ASCII only: PS 5.1 reads scripts without BOM as ANSI)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$work = Join-Path $env:TEMP 'ostrov-build'

# full paths, so packages' own "dist" folders inside node_modules are kept
robocopy $project $work /MIR /XD (Join-Path $project 'dist') (Join-Path $project '.git') /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy to $work failed ($LASTEXITCODE)" }

Push-Location $work
try {
    & npx electron-builder --win nsis
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$out = Join-Path $project 'dist'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $work 'dist\*.exe') $out -Force
Get-ChildItem $out -Filter *.exe | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
