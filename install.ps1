#Requires -Version 5.1
<#
    abs-butler, on Windows.

    A wrapper, and only a wrapper: the installer itself is a container image,
    the same one macOS and Linux run, so there is one installer to maintain
    rather than two that drift. This finds Docker, decides which folder the
    install lives in, and hands over.

        irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 | iex

    Run again later and it repairs what it finds: an install in the folder
    means the job is to check and mend it, not to make a second one. To be
    explicit, save it and pass a word or a flag:

        irm https://raw.githubusercontent.com/cwpetrich/abs-butler/main/install.ps1 -OutFile abs-butler.ps1
        .\abs-butler.ps1 repair
        .\abs-butler.ps1 update
        .\abs-butler.ps1 -ArgumentList install, --local

    Nothing here is Windows-specific except Windows itself. The decisions --
    which library to mount, which server to talk to, what to check -- are all
    in install.sh, inside the image.
#>
[CmdletBinding()]
param(
    # Passed straight to the installer: install, repair, update, or any flag
    # install.sh takes. Anything after -ArgumentList, or after the script name.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ArgumentList = @()
)

$ErrorActionPreference = 'Stop'

# Thrown rather than exited: piped into iex, this script *is* the session, and
# `exit` there closes the window somebody was about to read the message in.
function Fail([string] $message) {
    throw "abs-butler: $message"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker is not installed. Install Docker Desktop from https://docs.docker.com/desktop/install/windows-install/ and run this again.'
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Fail 'Docker is installed but not answering. Start Docker Desktop, wait for it to say "Engine running", and run this again.'
}

# Where the install goes. An existing install in this folder is the one to
# work on; otherwise an abs-butler folder beside wherever this was run, so a
# run from a home directory does not scatter files through it.
$here = (Get-Location).Path
$isInstall = { param($path) (Test-Path (Join-Path $path '.env')) -or (Test-Path (Join-Path $path 'docker-compose.yml')) }

if (& $isInstall $here) {
    $folder = $here
} else {
    $folder = Join-Path $here 'abs-butler'
    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
}

# An install already here is repaired rather than installed over -- that is
# what somebody running this a second time means by it.
$arguments = $ArgumentList
if ($arguments.Count -eq 0 -and (& $isInstall $folder)) {
    $arguments = @('repair')
    Write-Host 'abs-butler: an install is already here, so this checks and repairs it.'
}

$image = if ($env:ABS_BUTLER_INSTALLER_IMAGE) { $env:ABS_BUTLER_INSTALLER_IMAGE } else { 'ghcr.io/cwpetrich/abs-butler-installer:latest' }
# A terminal to prompt at, when there is one. Without -t docker refuses to run
# interactively; with it, and no console, it refuses just as firmly.
$tty = if ([Environment]::UserInteractive) { '-it' } else { '-i' }

$dockerArgs = @(
    'run', '--rm', $tty, '--pull', 'always',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', "${folder}:/install",
    $image
) + $arguments

Write-Host "abs-butler: using $folder"
Write-Host "abs-butler: docker $($dockerArgs -join ' ')"
Write-Host ''

& docker @dockerArgs

# Only when this is a file somebody ran: see Fail.
if ($PSCommandPath) { exit $LASTEXITCODE }
