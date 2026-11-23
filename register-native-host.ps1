# Register Sleepwalker Native Messaging Host in Windows Registry
param (
    [string]$ExtensionId = ""
)

$hostManifestPath = "D:\sleep\sleepwalker-native-host.json"
$regKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.sleepwalker.native_host"

Write-Host "Registering Sleepwalker Native Host..."
Write-Host "Manifest Path: $hostManifestPath"

# If an extension ID is provided, update allowed_origins in the manifest
if ($ExtensionId -ne "") {
    Write-Host "Adding Extension ID: $ExtensionId to allowed_origins"
    $origin = "chrome-extension://$ExtensionId/"
    if (Test-Path $hostManifestPath) {
        $json = Get-Content $hostManifestPath -Raw | ConvertFrom-Json
        $origins = [System.Collections.Generic.List[string]]::new($json.allowed_origins)
        if (-not $origins.Contains($origin)) {
            $origins.Add($origin)
            $json.allowed_origins = $origins.ToArray()
            $json | ConvertTo-Json -Depth 5 | Set-Content $hostManifestPath -Encoding UTF8
            Write-Host "Updated allowed_origins with $origin"
        }
    }
}

# Create registry key if it does not exist
if (-not (Test-Path $regKey)) {
    New-Item -Path $regKey -Force | Out-Null
}

# Set default registry value
Set-ItemProperty -Path $regKey -Name "(Default)" -Value $hostManifestPath
Write-Host "Successfully registered com.sleepwalker.native_host in $regKey"
