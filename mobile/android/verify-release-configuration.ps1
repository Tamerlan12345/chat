$ErrorActionPreference = 'Stop'

$buildScript = Join-Path $PSScriptRoot 'app/build.gradle.kts'
$source = [System.IO.File]::ReadAllText($buildScript)
$releaseMatch = [regex]::Match(
    $source,
    '(?ms)^\s*release\s*\{(?<body>.*?)^\s*}'
)

if (-not $releaseMatch.Success) {
    throw 'Release build type is not declared in app/build.gradle.kts.'
}

if ($releaseMatch.Groups['body'].Value -notmatch '(?m)^\s*isMinifyEnabled\s*=\s*true\s*$') {
    throw 'Release build type must set isMinifyEnabled = true.'
}

Write-Output 'Release configuration check passed: minification is enabled.'
