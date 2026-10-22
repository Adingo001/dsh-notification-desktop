param(
  [Parameter(Mandatory = $true)][string]$PayloadPath
)

# ASCII-only on purpose: Windows PowerShell reads a BOM-less script as the ANSI
# code page, so any literal non-ASCII text here would arrive as mojibake. All
# user-visible text is passed in through $PayloadPath as UTF-8 JSON instead.
$ErrorActionPreference = 'Stop'

$json = [System.IO.File]::ReadAllText($PayloadPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$aumid = if ($json.aumid) { [string]$json.aumid } else { 'electron.app.DeepSeek Harness' }

function Esc([string]$value) {
  if ($null -eq $value) { return '' }
  return $value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

$title = Esc([string]$json.title)
$body = Esc([string]$json.body)
# activationType="protocol" + launch: clicking the toast runs the registered
# `dshnotify:` handler (scripts\fix-toast-aumid.ps1 registers it), which raises
# the app window. Foreground activation would need a registered COM activator
# (ToastActivatorCLSID), and this shell never sets one.
$xmlText = "<toast launch='dshnotify:focus' activationType='protocol' duration='long'><visual><binding template='ToastGeneric'><text>$title</text><text>$body</text></binding></visual></toast>"

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xmlText)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc

# Keep the notifier in a variable: Windows PowerShell 5.1 does not allow
# `[Type]::Static($x).Method()` chaining, which fails as a parse error and
# therefore never shows anything.
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
try {
  $notifier.Show($toast)
  Write-Output 'TOAST-OK'
} catch {
  Write-Output ('TOAST-FAIL ' + $_.Exception.GetType().Name + ' :: ' + $_.Exception.Message)
  exit 1
}
