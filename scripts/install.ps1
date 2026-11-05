# One-command installer for Windows.
#
#   irm <this script's URL> | iex
#
# Downloads the latest build from this app's own releases, runs the installer
# silently, and launches the app. It still strips the "Mark of the Web"
# (Unblock-File) as belt-and-braces for older, unsigned builds.
#
# A build with no releases of its own (`links.releases` null in brand.json)
# has nothing to download, and this script says so and stops. It never falls
# back to another app's releases.
#
# Options (env vars):
#   $env:SHIPSTUDIO_NO_LAUNCH = '1'   install but don't open the app afterwards

$ErrorActionPreference = 'Stop'

# --- brand (generated from brand.json by `node scripts/check-brand.mjs --write`) ---
$BrandName       = 'Dashbot'
$BrandAppDirName = 'Dashbot'
$BrandReleases   = ''
# --- end brand ---

if (-not $BrandReleases) {
  throw "$BrandName has no published releases to install yet. Build it from source instead: see docs/INSTALLATION.md in its repository."
}

$asset = "${BrandAppDirName}_windows-x86_64-setup.exe"
$url   = "$($BrandReleases.TrimEnd('/'))/latest/download/$asset"
$out   = Join-Path $env:TEMP $asset

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "$BrandName requires 64-bit Windows."
}

Say "Downloading $BrandName..."
# TLS 1.2 for older PowerShell; turning the progress UI off makes IWR far faster.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $out

Say 'Preparing installer...'
Unblock-File -Path $out   # strip Mark-of-the-Web so SmartScreen does not block it

Say 'Installing (runs silently)...'
Start-Process -FilePath $out -ArgumentList '/S' -Wait

if (-not $env:SHIPSTUDIO_NO_LAUNCH) {
  Say "Launching $BrandName..."
  $menus = @(
    (Join-Path $env:APPDATA    'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  $shortcut = Get-ChildItem -Path $menus -Recurse -Filter "$BrandName*.lnk" -ErrorAction SilentlyContinue |
              Select-Object -First 1
  if ($shortcut) {
    Start-Process -FilePath $shortcut.FullName
  } else {
    Say "Installed. Launch '$BrandName' from the Start Menu."
  }
}

Remove-Item $out -ErrorAction SilentlyContinue
Say 'Done.'
