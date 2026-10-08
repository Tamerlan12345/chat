[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$reportsRoot = Join-Path $repositoryRoot 'mobile\qa\reports'

$reportFiles = [ordered]@{
    'release-signoff.md'        = @(
        'BLOCKED - DO NOT RELEASE',
        'macOS/Xcode simulator validation: PENDING',
        'iOS physical-device validation: PENDING'
    )
    'store-readiness-report.md' = @(
        'Apple App Store | NOT READY',
        'Google Play Store | NOT READY',
        'macOS/Xcode simulator validation: PENDING',
        'iOS physical-device validation: PENDING'
    )
    'parity-audit-report.md'    = @(
        'Current parity status: UNVERIFIED',
        'iOS simulator validation: PENDING',
        'iOS physical-device validation: PENDING'
    )
    'device-farm-handoff.md'    = @(
        'BrowserStack App Automate',
        'physical iOS device',
        'session URL',
        'artifact SHA-256',
        'result: PASS, FAIL, or BLOCKED'
    )
}

$unsupportedClaimPatterns = @(
    '(?i)PASSED\s*(?:&|AND)\s*APPROVED\s*FOR\s*RELEASE',
    '(?i)APPROVED\s+FOR\s+RELEASE',
    '(?i)READY\s+FOR\s+RELEASE',
    '(?i)READY\s+TO\s+SHIP',
    '(?i)ALL\s+BLOCKERS\s+(?:ARE\s+)?(?:REMOVED|RESOLVED)',
    '\u0413\u041e\u0422\u041e\u0412\u041e\s+\u041a\s+\u0420\u0415\u041b\u0418\u0417\u0423',
    '\u0414\u041e\u041f\u0423\u0429\u0415\u041d[\u0410-\u042f\u0401A-Z]*\s+\u041a\s+\u0420\u0415\u041b\u0418\u0417\u0423',
    '\u041f\u041e\u041b\u041d\u041e\u0421\u0422\u042c\u042e\s+\u0413\u041e\u0422\u041e\u0412[\u0410-\u042f\u0401A-Z]*\s+\u041a\s+\u0420\u0415\u041b\u0418\u0417\u0423',
    '\u041f\u041e\u041b\u041d\u042b\u0419\s+\u041f\u0410\u0420\u0418\u0422\u0415\u0422\s*\(?\s*100\s*%\s*\)?',
    '\u041f\u0410\u0420\u0418\u0422\u0415\u0422[^\r\n]{0,80}100\s*%'
)

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($entry in $reportFiles.GetEnumerator()) {
    $path = Join-Path $reportsRoot $entry.Key
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("Missing release evidence report: $($entry.Key)")
        continue
    }

    $content = Get-Content -LiteralPath $path -Raw -Encoding utf8
    foreach ($marker in $entry.Value) {
        if ($content.IndexOf($marker, [System.StringComparison]::Ordinal) -lt 0) {
            $failures.Add("$($entry.Key) is missing required evidence marker: $marker")
        }
    }

    foreach ($pattern in $unsupportedClaimPatterns) {
        if ([System.Text.RegularExpressions.Regex]::IsMatch($content, $pattern)) {
            $failures.Add("$($entry.Key) contains unsupported release claim matching: $pattern")
        }
    }
}

if ($failures.Count -gt 0) {
    $failures | Sort-Object | ForEach-Object { [Console]::Error.WriteLine($_) }
    throw "Release evidence consistency check failed with $($failures.Count) violation(s)."
}

Write-Output 'Release evidence consistency check passed.'
