#!/usr/bin/env pwsh
# Inflexa installer for Windows — downloads a release binary, verifies it
# against the release's SHA256SUMS, installs it, and puts it on the user PATH.
#
#   irm https://inflexa.ai/install.ps1 | iex
#
# (inflexa.ai/install.ps1 redirects to this file on the repo's main branch;
# the raw.githubusercontent.com URL works directly as well.)
#
# Pinning / options:
#   iex "& {$(irm https://inflexa.ai/install.ps1)} -Version 0.1.0 -NoPathUpdate"
#
# Runs on both Windows PowerShell 5.1 (the OS default, what a fresh machine's
# `irm | iex` lands in) and PowerShell 7+; the places their APIs diverge are
# branched explicitly below.
param(
  [string]$Version = "",
  [string]$InstallDir = "",
  [switch]$NoPathUpdate = $false
)
$ErrorActionPreference = "Stop"

function Install-Inflexa {
  $repo = "inflexa-ai/inflexa"

  # 5.1 negotiates TLS 1.0 by default, which GitHub rejects; 7+ ignores this.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $dir = $InstallDir
  if (-not $dir) { $dir = $env:INFLEXA_INSTALL_DIR }
  if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA "Programs\inflexa" }

  # Read the arch from the registry, not $env:PROCESSOR_ARCHITECTURE: a 32-bit
  # PowerShell on a 64-bit OS reports its own WOW64 view in the environment.
  $archRaw = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment").PROCESSOR_ARCHITECTURE
  switch ($archRaw) {
    "AMD64" { }
    "ARM64" {
      # No native arm64 build is published; Windows 11 on ARM runs x64
      # binaries under emulation, so install that rather than failing.
      Write-Host "Note: no native Windows arm64 build yet - installing the x64 binary (runs under emulation)."
    }
    default { throw "inflexa supports 64-bit Windows only (detected: $archRaw)" }
  }
  $asset = "inflexa-windows-x64.exe"

  if ($Version) {
    $tag = "v" + $Version.TrimStart("v")
  } else {
    # The /releases/latest redirect resolves the newest tag without touching
    # the GitHub API and its unauthenticated rate limits. Where the final URL
    # is exposed differs by engine: 5.1's response is an HttpWebResponse
    # (ResponseUri), 7+'s wraps an HttpRequestMessage (RequestUri).
    $resp = Invoke-WebRequest -UseBasicParsing -Method Head -Uri "https://github.com/$repo/releases/latest"
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      $final = $resp.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    } else {
      $final = $resp.BaseResponse.ResponseUri.AbsoluteUri
    }
    $tag = $final.Split("/")[-1]
  }
  if ($tag -notmatch '^v\d+\.\d+\.\d+') { throw "could not determine a release version (got: '$tag')" }

  Write-Host "Installing inflexa $tag ($asset)..."
  $base = "https://github.com/$repo/releases/download/$tag"

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("inflexa-install-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # IWR's progress rendering slows large downloads dramatically on 5.1.
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")
    $ProgressPreference = $oldProgress

    # The hash comes from the release's own SHA256SUMS — the file the release
    # workflow generated and attested — so this installs exactly what that
    # workflow built.
    $sumLine = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { $_ -match ("\s" + [regex]::Escape($asset) + "$") }
    if (-not $sumLine) { throw "$asset is not listed in the release's SHA256SUMS" }
    $expected = ("$sumLine" -split "\s+")[0].ToLower()
    $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { throw "checksum mismatch for $asset - expected $expected, got $actual. NOT installing." }

    # Stage inside the target dir so the final rename is atomic: an existing
    # inflexa.exe is either the old binary or the new one, never half-written.
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $staged = Join-Path $dir ".inflexa.install.exe"
    Copy-Item (Join-Path $tmp $asset) $staged -Force
    # The download carries mark-of-the-web; the user explicitly asked for this
    # install, so strip it here instead of leaving SmartScreen to block the
    # first run of a checksum-verified binary.
    Unblock-File -Path $staged -ErrorAction SilentlyContinue
    Move-Item -Force $staged (Join-Path $dir "inflexa.exe")
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $exe = Join-Path $dir "inflexa.exe"
  $installed = & $exe --version
  if ($LASTEXITCODE -ne 0) { throw "the installed binary failed to run" }
  Write-Host "Installed inflexa $installed -> $exe"

  if (-not $NoPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ";") -notcontains $dir) {
      [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
      Write-Host "Added $dir to your user PATH. Restart your shell to pick it up."
    }
    if (($env:Path -split ";") -notcontains $dir) { $env:Path = "$env:Path;$dir" }
  }
}

Install-Inflexa
