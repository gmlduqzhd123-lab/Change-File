# 툭 빌드: 윈도우에 들어 있는 .NET Framework C# 컴파일러만 씁니다.
#   powershell -ExecutionPolicy Bypass -File .\build.ps1                       →  build\Tuk.exe
#   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Release -Notes "고친 점"
#       → docs\download\Tuk.zip (받기 단추), docs\download\Tuk.exe·docs\version.json (앱 안 업데이트)
#   새 버전을 낼 때는 src\Tuk.cs의 Version을 올린 뒤 -Release로 만들고 커밋·푸시하면 됩니다.
param([switch]$Release, [string]$Notes = "")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$fw = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
$out = Join-Path $root 'build'
New-Item -ItemType Directory -Force $out | Out-Null

$refs = 'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
        'Microsoft.CSharp.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll',
        'WPF\PresentationCore.dll', 'WPF\WindowsBase.dll', 'System.Xaml.dll',
        'System.Runtime.dll', 'System.Runtime.WindowsRuntime.dll' |
        ForEach-Object { "/reference:" + (Join-Path $fw $_) }
# PDF → JPG: 윈도우 10·11에 들어 있는 PDF 그리기 기능(Windows.Data.Pdf)
$winmd = Join-Path $env:WINDIR 'System32\WinMetadata'
$refs += 'Windows.Foundation.winmd', 'Windows.Storage.winmd', 'Windows.Data.winmd' |
        ForEach-Object { "/reference:" + (Join-Path $winmd $_) }

$src = Join-Path $root 'src\Tuk.cs'
$exe = Join-Path $out 'Tuk.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu /codepage:65001 /utf8output /warn:4 "/out:$exe" @refs $src
if ($LASTEXITCODE -ne 0) { throw "컴파일 실패 ($LASTEXITCODE)" }
Write-Host "만들었습니다: $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB)"

if ($Release) {
    $m = [regex]::Match([IO.File]::ReadAllText($src), 'public const string Version = "([0-9.]+)"')
    if (-not $m.Success) { throw "src\Tuk.cs에서 Version을 찾지 못했습니다." }
    $ver = $m.Groups[1].Value
    $site = 'https://gmlduqzhd123-lab.github.io/Change-File/'
    $docs = Join-Path $root 'docs'
    $dl = Join-Path $docs 'download'
    New-Item -ItemType Directory -Force $dl | Out-Null

    # 받기 단추용 ZIP: Tuk.exe + 설치 안내
    $stage = Join-Path $out 'stage'
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory $stage | Out-Null
    Copy-Item $exe (Join-Path $stage 'Tuk.exe')
    Copy-Item (Join-Path $root '설치 안내.txt') (Join-Path $stage '설치 안내.txt')
    $zip = Join-Path $dl 'Tuk.zip'
    if (Test-Path $zip) { Remove-Item -Force $zip }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)
    Remove-Item -Recurse -Force $stage

    # 앱 안 업데이트용: 실행 파일과 version.json
    Copy-Item $exe (Join-Path $dl 'Tuk.exe') -Force
    $sha = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        version = $ver; url = $site + 'download/Tuk.exe'; sha256 = $sha; notes = $Notes
        zip = $site + 'download/Tuk.zip'; zipBytes = (Get-Item $zip).Length; date = (Get-Date -Format 'yyyy-MM-dd')
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $docs 'version.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
    Write-Host "배포 파일: docs\download\Tuk.zip, docs\download\Tuk.exe, docs\version.json (버전 $ver)"
}