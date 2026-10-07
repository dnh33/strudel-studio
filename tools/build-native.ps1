# Builds the Strudel Studio native app (JUCE) on Windows.
#
#   - installs the free Visual Studio Build Tools (C++ compiler + CMake + Ninja) with winget if they're missing
#     (one time, ~3-5 GB, may show a Windows admin prompt)
#   - downloads JUCE 9 and the WebView2 SDK (done by CMake, first build only)
#   - builds "Strudel Studio.exe" and the example VST3 plug-ins, and puts them in this folder
#
# Usage:  Build Native App.bat            (or: powershell -ExecutionPolicy Bypass -File tools\build-native.ps1)
#         options: -Clean  (fresh build folder)   -Debug  (debug build)   -NoInstall  (never install anything)
#
# Works with Windows PowerShell 5.1 and PowerShell 7.

param(
    [switch]$Clean,
    [switch]$Debug,
    [switch]$NoInstall,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'native'
$buildDir = Join-Path $native 'build'
$logFile = Join-Path $native 'build.log'
$config = 'Release'
if ($Debug) { $config = 'Debug' }

function Log($text) {
    Add-Content -Path $logFile -Value $text -Encoding UTF8
}

function Say($msg, $color) {
    if (-not $color) { $color = 'Gray' }
    Write-Host $msg -ForegroundColor $color
    Log ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg)
}

# runs a command line through cmd.exe, shows its output and appends it to the log; returns the exit code
function Run($cmdline, [switch]$Quiet) {
    Log ("> " + $cmdline)
    cmd /c "$cmdline 2>&1" | ForEach-Object {
        if (-not $Quiet) { Write-Host $_ }
        Log $_
    }
    return $LASTEXITCODE
}

function Fail($msg) {
    Say ''
    Say ("ERROR: " + $msg) 'Red'
    Say ("The full log is in " + $logFile) 'Yellow'
    exit 1
}

New-Item -ItemType Directory -Force -Path $native | Out-Null
Set-Content -Path $logFile -Value ("Strudel Studio native build - " + (Get-Date)) -Encoding UTF8
$env:VSLANG = '1033'   # English compiler messages in the log
Say ''
Say '=== Strudel Studio - native app build ===' 'Cyan'
Say ("Project folder: " + $root)

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'A 64-bit Windows is required.' }

# ------------------------------------------------------------------ 1. the web app
if (-not (Test-Path (Join-Path $root 'app\index.html'))) {
    Say 'The built web app (app\index.html) is missing - building it with npm...' 'Yellow'
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail 'app\index.html is missing and Node.js/npm is not installed. Install Node.js LTS (winget install OpenJS.NodeJS.LTS) and run this again.'
    }
    Push-Location $root
    try {
        if ((Run 'npm install --no-audit --no-fund' -Quiet) -ne 0) { Fail 'npm install failed.' }
        if ((Run 'npm run build' -Quiet) -ne 0) { Fail 'npm run build failed.' }
    } finally { Pop-Location }
}
Say 'Web app: OK' 'Green'

# ------------------------------------------------------------------ 2. Visual Studio Build Tools (C++)
function Find-VS {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $null }
    $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($path) { return ($path | Select-Object -First 1).Trim() }
    return $null
}

$vs = Find-VS
if (-not $vs) {
    if ($NoInstall) { Fail 'Visual Studio C++ Build Tools were not found (and -NoInstall was given).' }
    Say ''
    Say 'The C++ compiler (Visual Studio Build Tools) is not installed yet.' 'Yellow'
    Say 'Installing it now with winget - this is free, happens once, downloads a few GB and can take 10-20 minutes.' 'Yellow'
    Say 'Windows may ask for administrator permission.' 'Yellow'
    $vsArgs = '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.VC.CMake.Project'
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $installed = $false
    if ($winget) {
        foreach ($id in @('Microsoft.VisualStudio.BuildTools', 'Microsoft.VisualStudio.2022.BuildTools')) {
            Say ("winget install " + $id + " ...")
            & winget install --id $id -e --accept-package-agreements --accept-source-agreements --override $vsArgs
            $vs = Find-VS
            if ($vs) { $installed = $true; break }
        }
    }
    if (-not $installed) {
        # no winget (or it failed): use Microsoft's bootstrapper directly
        Say 'Downloading the Visual Studio Build Tools installer from Microsoft...'
        $boot = Join-Path $env:TEMP 'vs_BuildTools.exe'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        try { Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/stable/vs_BuildTools.exe' -OutFile $boot -ErrorAction Stop }
        catch { Fail ('Could not download the Build Tools installer: ' + $_.Exception.Message) }
        $p = Start-Process -FilePath $boot -ArgumentList $vsArgs -Wait -PassThru
        Say ("Installer exit code: " + $p.ExitCode)
        $vs = Find-VS
    }
    if (-not $vs) { Fail 'The Visual Studio Build Tools could not be installed. Install "Desktop development with C++" from https://visualstudio.microsoft.com/downloads/ (Build Tools) and run this again.' }
}
Say ("C++ Build Tools: " + $vs) 'Green'

# ------------------------------------------------------------------ 3. developer environment (cl, cmake, ninja)
$devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $devCmd)) { Fail ("VsDevCmd.bat not found in " + $vs) }
# (a little batch file avoids cmd.exe quoting trouble with paths that contain spaces)
$envBat = Join-Path $env:TEMP 'strudel-studio-vsenv.bat'
Set-Content -Path $envBat -Encoding ASCII -Value ("@call `"" + $devCmd + "`" -arch=x64 -host_arch=x64 -no_logo >nul`r`n@set")
$envDump = cmd /c $envBat
Remove-Item $envBat -ErrorAction SilentlyContinue
foreach ($line in $envDump) {
    if ($line -match '^([^=]+)=(.*)$') { Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2] }
}
$cmakeDir = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake'
if (Test-Path $cmakeDir) {
    $env:PATH = (Join-Path $cmakeDir 'CMake\bin') + ';' + (Join-Path $cmakeDir 'Ninja') + ';' + $env:PATH
}
if (-not (Get-Command cl -ErrorAction SilentlyContinue)) { Fail 'The MSVC compiler (cl.exe) is not available. Repair the Build Tools installation ("Desktop development with C++").' }
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
    if ($NoInstall) { Fail 'CMake not found.' }
    Say 'CMake not found - installing it with winget...' 'Yellow'
    & winget install --id Kitware.CMake -e --accept-package-agreements --accept-source-agreements
    $env:PATH = (Join-Path $env:ProgramFiles 'CMake\bin') + ';' + $env:PATH
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { Fail 'CMake could not be installed.' }
}
$generator = 'Ninja'
if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) { $generator = 'NMake Makefiles' }
Say ("Compiler: " + ((cmd /c "cl 2>&1" | Select-Object -First 1)))
Say ("CMake: " + ((cmake --version | Select-Object -First 1)) + " / generator: " + $generator)

# ------------------------------------------------------------------ 4. WebView2 runtime (ships with Windows 10/11)
$wv2 = $null
foreach ($key in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
                   'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
    if (Test-Path $key) { $wv2 = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).pv }
    if ($wv2) { break }
}
if ($wv2) { Say ("WebView2 runtime: " + $wv2) 'Green' }
elseif (-not $NoInstall -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Say 'WebView2 runtime not found - installing it with winget...' 'Yellow'
    & winget install --id Microsoft.EdgeWebView2Runtime -e --accept-package-agreements --accept-source-agreements
} else { Say 'WebView2 runtime not detected - the app will tell you if it is really missing.' 'Yellow' }

# ------------------------------------------------------------------ 5. configure + build
if ($Clean -and (Test-Path $buildDir)) {
    Say 'Removing the old build folder...'
    Remove-Item -Recurse -Force $buildDir
}
Say ''
Say 'Configuring (the first time this downloads JUCE 9 and the WebView2 SDK, ~150 MB)...' 'Cyan'
$code = Run ("cmake -S `"" + $native + "`" -B `"" + $buildDir + "`" -G `"" + $generator + "`" -DCMAKE_BUILD_TYPE=" + $config) -Quiet
if ($code -ne 0) { Fail 'CMake configuration failed (network problem? see the log).' }

Say 'Compiling (5-15 minutes the first time)...' 'Cyan'
$sw = [Diagnostics.Stopwatch]::StartNew()
$code = Run ("cmake --build `"" + $buildDir + "`" --config " + $config)
if ($code -ne 0) { Fail 'The build failed - see the end of the log.' }
Say ("Built in {0:N0} s" -f $sw.Elapsed.TotalSeconds) 'Green'

# ------------------------------------------------------------------ 6. put the results next to the web app
$exe = Get-ChildItem -Path (Join-Path $buildDir 'StrudelStudio_artefacts') -Recurse -Filter 'Strudel Studio.exe' | Select-Object -First 1
if (-not $exe) { Fail 'Strudel Studio.exe was not produced.' }
$target = Join-Path $root 'Strudel Studio.exe'
try { Copy-Item -Force $exe.FullName $target -ErrorAction Stop }
catch { Fail ('Could not copy the app (is Strudel Studio still running?): ' + $_.Exception.Message) }
Say ("App: " + $target) 'Green'

$vst3Out = Join-Path $root 'VST3'
foreach ($name in @('Strudel Test Synth.vst3', 'Strudel Test Drive.vst3')) {
    $bundle = Get-ChildItem -Path $buildDir -Recurse -Directory -Filter $name | Where-Object { $_.FullName -match 'VST3' } | Select-Object -First 1
    if ($bundle) {
        New-Item -ItemType Directory -Force -Path $vst3Out | Out-Null
        $dest = Join-Path $vst3Out $name
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Copy-Item -Recurse -Force $bundle.FullName $dest
        Say ("Example plug-in: " + $dest) 'Green'
    }
}

Say ''
Say 'Done! Start "Strudel Studio.exe" in the project folder.' 'Cyan'
Say 'First time: open the Audio menu -> "Scan for new VST3 plug-ins", then add a VST3 channel from the browser or the channel rack "+" menu.' 'Cyan'
exit 0
