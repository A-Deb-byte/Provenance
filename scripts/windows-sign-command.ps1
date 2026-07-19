[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$Artifact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RequiredEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value) -or $value -cne $value.Trim()) {
    throw "$Name must be present in canonical form."
  }
  return $value
}

function Get-CanonicalItem {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$Directory,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path." }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -ne $Directory) { throw "$Label has the wrong filesystem type." }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a reparse point."
  }
  return $item
}

function Test-ContainedPath {
  param(
    [Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$File,
    [Parameter(Mandatory = $true)][System.IO.DirectoryInfo]$Root
  )

  $rootFull = [IO.Path]::GetFullPath($Root.FullName).TrimEnd('\', '/')
  $fileFull = [IO.Path]::GetFullPath($File.FullName)
  if (-not $fileFull.StartsWith(
    $rootFull + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    return $false
  }

  $current = $File.Directory
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Signing candidates must not traverse reparse-point directories.'
    }
    if ([string]::Equals(
      [IO.Path]::GetFullPath($current.FullName).TrimEnd('\', '/'),
      $rootFull,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      return $true
    }
    $current = $current.Parent
  }
  return $false
}

function Test-ExactPath {
  param(
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  return [string]::Equals(
    [IO.Path]::GetFullPath($Actual),
    [IO.Path]::GetFullPath($Expected),
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Assert-NotSigned {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'NotSigned' -or
      $null -ne $signature.SignerCertificate -or
      $null -ne $signature.TimeStamperCertificate) {
    throw "$Label must remain unsigned."
  }
}

foreach ($blocked in @(
  'WINDOWS_PFX_BASE64',
  'WINDOWS_PFX_PASSWORD',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
)) {
  if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($blocked))) {
    throw "$blocked must not be exposed to the constrained signing command."
  }
}

$artifactItem = Get-CanonicalItem -Path $Artifact -Directory $false -Label 'Signing candidate'
if ($artifactItem.Length -le 0 -or $artifactItem.Length -gt 1GB) {
  throw 'The signing candidate must have a bounded non-zero size.'
}
$artifactFull = [IO.Path]::GetFullPath($artifactItem.FullName)

$releaseTarget = Get-CanonicalItem `
  -Path (Get-RequiredEnvironmentValue -Name 'PROVENANCE_RELEASE_TARGET_DIR') `
  -Directory $true `
  -Label 'Fresh release target'
$releaseTargetFull = [IO.Path]::GetFullPath($releaseTarget.FullName).TrimEnd('\', '/')

# Tauri 2.11.4 asks the custom signer to process every PE resource. The pinned
# Node runtime is already vendor-signed, so its exact staged callback is a no-op.
$stagedNodePath = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_STAGED_NODE_PATH'
if (Test-ExactPath -Actual $artifactFull -Expected $stagedNodePath) {
  if (-not (Test-ContainedPath -File $artifactItem -Root $releaseTarget) -or
      $artifactItem.Name -cne 'node.exe') {
    throw 'The pinned runtime callback is outside the exact release staging target.'
  }
  $expectedNodeHash = (Get-RequiredEnvironmentValue -Name 'PROVENANCE_BUNDLED_NODE_SHA256').ToLowerInvariant()
  if ($expectedNodeHash -notmatch '^[a-f0-9]{64}$' -or
      (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactFull).Hash.ToLowerInvariant() -cne $expectedNodeHash) {
    throw 'The pinned runtime callback does not match the manifest-bound Node executable.'
  }
  $nodeSignature = Get-AuthenticodeSignature -LiteralPath $artifactFull
  $expectedNodeSigner = (Get-RequiredEnvironmentValue -Name 'PROVENANCE_BUNDLED_NODE_SIGNER_THUMBPRINT').Replace(' ', '').ToUpperInvariant()
  if ($expectedNodeSigner -notmatch '^[A-F0-9]{40}$') {
    throw 'The pinned Node signer thumbprint is invalid.'
  }
  if ($nodeSignature.Status -ne 'Valid' -or
      $null -eq $nodeSignature.SignerCertificate -or
      $nodeSignature.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $expectedNodeSigner -or
      $null -eq $nodeSignature.TimeStamperCertificate) {
    throw 'The pinned Node runtime must retain its valid vendor signature and timestamp.'
  }
  return
}

if (-not (Test-ContainedPath -File $artifactItem -Root $releaseTarget)) {
  throw 'The signing candidate must be contained by the exact fresh release target.'
}

# Tauri copies five NSIS build-time plugins and invokes the signer for them.
# They stay unsigned; the signed setup envelope authenticates their bytes.
$pluginRoot = Join-Path $releaseTargetFull 'release\nsis\x64\Plugins\x86-unicode'
$pluginRelativePaths = @(
  'NSISdl.dll',
  'StartMenu.dll',
  'System.dll',
  'nsDialogs.dll',
  'additional\nsis_tauri_utils.dll'
)
foreach ($relative in $pluginRelativePaths) {
  if (Test-ExactPath -Actual $artifactFull -Expected (Join-Path $pluginRoot $relative)) {
    Assert-NotSigned -Path $artifactFull -Label 'The copied NSIS build-time plugin'
    return
  }
}

$nativePath = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_NATIVE_PATH'
$expectedNative = Join-Path $releaseTargetFull 'release\provenance-desktop.exe'
if (-not (Test-ExactPath -Actual $nativePath -Expected $expectedNative)) {
  throw 'The native signing allowlist path does not match the exact fresh release target.'
}
$isNative = (Test-ExactPath -Actual $artifactFull -Expected $expectedNative) -and
  $artifactItem.Name -ceq 'provenance-desktop.exe'

$nsisRoot = Get-CanonicalItem `
  -Path (Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_NSIS_ROOT') `
  -Directory $true `
  -Label 'NSIS uninstaller signing root'
$expectedNsisRoot = Join-Path $releaseTargetFull 'release\nsis\signing-temp'
if (-not (Test-ExactPath -Actual $nsisRoot.FullName -Expected $expectedNsisRoot)) {
  throw 'The NSIS signing root does not match the dedicated fresh-target directory.'
}
$isUninstaller = (Test-ExactPath -Actual $artifactItem.Directory.FullName -Expected $nsisRoot.FullName) -and
  $artifactItem.Name -match '^(?i:nst[0-9a-f]{4}\.tmp)$'

$bundleRoot = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_BUNDLE_ROOT'
$expectedBundleRoot = Join-Path $releaseTargetFull 'release\bundle'
if (-not (Test-ExactPath -Actual $bundleRoot -Expected $expectedBundleRoot)) {
  throw 'The installer signing root does not match the exact fresh release target.'
}
$expectedInstallerName = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_EXPECTED_INSTALLER_NAME'
if ($expectedInstallerName -notmatch '^Provenance_[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?_x64-setup\.exe$') {
  throw 'The expected NSIS installer name is invalid.'
}
$expectedInstaller = Join-Path (Join-Path $expectedBundleRoot 'nsis') $expectedInstallerName
$isInstaller = (Test-ExactPath -Actual $artifactFull -Expected $expectedInstaller) -and
  $artifactItem.Name -ceq $expectedInstallerName

$capturePath = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGN_CAPTURE_PATH'
$expectedCapture = Join-Path $releaseTargetFull 'release\attestation\provenance-desktop-signed.exe'
if (-not (Test-ExactPath -Actual $capturePath -Expected $expectedCapture)) {
  throw 'The signed-native capture path does not match the exact fresh release target.'
}

if (-not $isNative -and -not $isUninstaller -and -not $isInstaller) {
  throw 'The signing candidate is outside the exact native, NSIS uninstaller, and setup allowlist.'
}
if ($isUninstaller) {
  if ([IO.Path]::GetExtension($artifactItem.Name) -cne '.tmp') {
    throw 'The NSIS uninstaller must use the exact NSIS temporary-file shape.'
  }
} elseif ([IO.Path]::GetExtension($artifactItem.Name) -cne '.exe') {
  throw 'Native and setup signing candidates must be Windows .exe files.'
}

$thumbprint = (Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_CERTIFICATE_THUMBPRINT').Replace(' ', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'The signing certificate thumbprint is invalid.' }

$timestampUrl = Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_TIMESTAMP_URL'
$timestampUri = $null
if (-not [Uri]::TryCreate($timestampUrl, [UriKind]::Absolute, [ref]$timestampUri) -or
    $timestampUri.Scheme -cne 'https' -or $timestampUri.UserInfo -or
    $timestampUri.Fragment -or $timestampUri.Query) {
  throw 'The RFC3161 timestamp service must be a query-free, credential-free HTTPS URL.'
}

$existing = Get-AuthenticodeSignature -LiteralPath $artifactFull
if ($existing.Status -eq 'Valid' -and
    $null -ne $existing.SignerCertificate -and
    $existing.SignerCertificate.Thumbprint.ToUpperInvariant() -ceq $thumbprint -and
    $null -ne $existing.TimeStamperCertificate) {
  return
}
if ($existing.Status -ne 'NotSigned' -or $null -ne $existing.SignerCertificate) {
  throw 'The signing candidate already has an unexpected or invalid signature.'
}

$certificates = @(Get-ChildItem -LiteralPath Cert:\CurrentUser\My | Where-Object {
  $_.Thumbprint.ToUpperInvariant() -ceq $thumbprint
})
if ($certificates.Count -ne 1 -or -not $certificates[0].HasPrivateKey) {
  throw 'The expected private code-signing certificate is not uniquely available.'
}
$codeSigningEku = @($certificates[0].EnhancedKeyUsageList | Where-Object {
  $_.ObjectId.Value -ceq '1.3.6.1.5.5.7.3.3'
})
if ($codeSigningEku.Count -ne 1) { throw 'The selected certificate is not authorized for code signing.' }

$signTool = Get-CanonicalItem `
  -Path (Get-RequiredEnvironmentValue -Name 'PROVENANCE_WINDOWS_SIGNTOOL') `
  -Directory $false `
  -Label 'signtool.exe'
if ($signTool.Name -cne 'signtool.exe') { throw 'The signing tool must be signtool.exe.' }
$sdkRoot = Get-CanonicalItem `
  -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin') `
  -Directory $true `
  -Label 'Windows SDK signing root'
if (-not (Test-ContainedPath -File $signTool -Root $sdkRoot)) {
  throw 'signtool.exe must come from the installed Windows 10 SDK.'
}
$signToolSignature = Get-AuthenticodeSignature -LiteralPath $signTool.FullName
if ($signToolSignature.Status -ne 'Valid' -or $null -eq $signToolSignature.SignerCertificate -or
    $signToolSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
  throw 'signtool.exe does not have a valid Microsoft Authenticode signature.'
}

& $signTool.FullName sign /sha1 $thumbprint /s My /fd SHA256 /tr $timestampUri.AbsoluteUri /td SHA256 $artifactFull
if ($LASTEXITCODE -ne 0) { throw "signtool.exe failed with exit code $LASTEXITCODE." }

$verified = Get-AuthenticodeSignature -LiteralPath $artifactFull
if ($verified.Status -ne 'Valid' -or $null -eq $verified.SignerCertificate -or
    $verified.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $thumbprint -or
    $null -eq $verified.TimeStamperCertificate) {
  throw 'The resulting Authenticode signer, signature, or RFC3161 timestamp is invalid.'
}

if ($isNative) {
  $captureDirectory = Get-CanonicalItem `
    -Path ([IO.Path]::GetDirectoryName($expectedCapture)) `
    -Directory $true `
    -Label 'Signed-native attestation directory'
  if (-not (Test-ExactPath -Actual $captureDirectory.FullName -Expected (Join-Path $releaseTargetFull 'release\attestation'))) {
    throw 'The signed-native attestation directory is invalid.'
  }
  $source = $null
  $destination = $null
  try {
    $source = [IO.File]::Open($artifactFull, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $destination = [IO.File]::Open($expectedCapture, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $source.CopyTo($destination)
    $destination.Flush($true)
  } finally {
    if ($null -ne $destination) { $destination.Dispose() }
    if ($null -ne $source) { $source.Dispose() }
  }
  $capture = Get-CanonicalItem -Path $expectedCapture -Directory $false -Label 'Signed-native capture'
  $signedArtifact = Get-CanonicalItem -Path $artifactFull -Directory $false -Label 'Signed native executable'
  if ($capture.Length -ne $signedArtifact.Length -or
      (Get-FileHash -Algorithm SHA256 -LiteralPath $capture.FullName).Hash -cne
      (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactFull).Hash) {
    throw 'The create-new signed-native capture is not byte-identical to the signed executable.'
  }
  $captureSignature = Get-AuthenticodeSignature -LiteralPath $capture.FullName
  if ($captureSignature.Status -ne 'Valid' -or $null -eq $captureSignature.SignerCertificate -or
      $captureSignature.SignerCertificate.Thumbprint.ToUpperInvariant() -cne $thumbprint -or
      $null -eq $captureSignature.TimeStamperCertificate) {
    throw 'The signed-native capture does not retain the expected signature and timestamp.'
  }
}
