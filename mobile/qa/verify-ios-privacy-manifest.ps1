[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$manifestPath = Join-Path $repositoryRoot 'mobile/ios/CentyChat/Resources/PrivacyInfo.xcprivacy'
$swiftRoot = Join-Path $repositoryRoot 'mobile/ios/CentyChat'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Missing privacy manifest: $manifestPath"
}

[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
$trackingValue = $manifest.SelectSingleNode('/plist/dict/key[text()="NSPrivacyTracking"]/following-sibling::*[1]')
if ($null -eq $trackingValue -or $trackingValue.Name -ne 'false') {
    throw 'The checked-in client does not include tracking; NSPrivacyTracking must be false.'
}

$source = (Get-ChildItem -LiteralPath $swiftRoot -Recurse -Filter '*.swift' -File |
    Get-Content -LiteralPath { $_.FullName } -Raw) -join "`n"

$usagePatterns = @{
    'NSPrivacyAccessedAPICategoryUserDefaults' = 'UserDefaults'
    'NSPrivacyAccessedAPICategoryFileTimestamp' = 'attributesOfItem|resourceValues\(|contentModificationDate|creationDate'
    'NSPrivacyAccessedAPICategoryDiskSpace' = 'volumeAvailableCapacity|volumeTotalCapacity'
    'NSPrivacyAccessedAPICategorySystemBootTime' = 'systemUptime'
    'NSPrivacyAccessedAPICategoryActiveKeyboards' = 'activeInputModes'
}

$accessedTypesArray = $manifest.SelectSingleNode('/plist/dict/key[text()="NSPrivacyAccessedAPITypes"]/following-sibling::array[1]')
if ($null -eq $accessedTypesArray) {
    throw 'Privacy manifest must contain NSPrivacyAccessedAPITypes, even when it is empty.'
}

$unsupportedDeclarations = @()
foreach ($entry in $accessedTypesArray.SelectNodes('./dict')) {
    $typeNode = $entry.SelectSingleNode('./key[text()="NSPrivacyAccessedAPIType"]/following-sibling::string[1]')
    if ($null -eq $typeNode) {
        throw 'Every accessed API declaration must identify its API category.'
    }

    $apiType = $typeNode.InnerText
    $pattern = $usagePatterns[$apiType]
    if ($null -ne $pattern -and $source -notmatch $pattern) {
        $unsupportedDeclarations += $apiType
    }
}

if ($unsupportedDeclarations.Count -gt 0) {
    throw "Privacy manifest declares APIs not used by this app: $($unsupportedDeclarations -join ', ')"
}

Write-Output 'iOS privacy manifest contract passed.'
