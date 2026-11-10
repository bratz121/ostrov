# Builds the Tauri installer. Rust and the build output live on drive D (D:\Rust),
# and the finished installer is copied to dist\. Run with: npm run dist:tauri
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$env:RUSTUP_HOME = 'D:\Rust\rustup'
$env:CARGO_HOME = 'D:\Rust\cargo'
$env:CARGO_TARGET_DIR = 'D:\Rust\target\ostrov'
$env:Path += ';D:\Rust\cargo\bin'

Push-Location $project
try {
    & npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$setup = Get-ChildItem "$env:CARGO_TARGET_DIR\release\bundle\nsis" -Filter *-setup.exe | Sort-Object LastWriteTime | Select-Object -Last 1
$version = (Get-Content (Join-Path $project 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force (Join-Path $project 'dist') | Out-Null
Copy-Item $setup.FullName (Join-Path $project "dist\Ostrov-Setup-$version.exe") -Force
"dist\Ostrov-Setup-$version.exe: {0:N1} MB" -f ($setup.Length / 1MB)
