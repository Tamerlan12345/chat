$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$workflowRoot = Join-Path $repositoryRoot '.github\workflows'

function Require-WorkflowContract {
    param(
        [string]$Path,
        [string[]]$RequiredPatterns
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing workflow: $Path"
    }

    $contents = Get-Content -LiteralPath $Path -Raw
    foreach ($pattern in $RequiredPatterns) {
        if ($contents -notmatch $pattern) {
            throw "Workflow $Path is missing required contract: $pattern"
        }
    }
}

Require-WorkflowContract -Path (Join-Path $workflowRoot 'mobile-android.yml') -RequiredPatterns @(
    '(?m)^\s*android-verify:',
    'mobile/android/gradlew',
    'testDebugUnitTest',
    '\blint\b',
    'assembleDebug',
    'assembleRelease',
    'actions/upload-artifact@',
    'test-results'
)

Require-WorkflowContract -Path (Join-Path $workflowRoot 'mobile-ios.yml') -RequiredPatterns @(
    '(?m)^\s*ios-simulator-tests:',
    'runs-on:\s*macos-',
    'xcodebuild',
    'CentyChat\.xcodeproj',
    'CentyChat',
    'iPhone 16',
    'CODE_SIGNING_ALLOWED=NO',
    'actions/upload-artifact@',
    'xcresult'
)

Write-Output 'Mobile CI workflow contracts passed.'
