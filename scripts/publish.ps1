# Creates the GitHub repository and pushes this package to it.
#
#   $env:GITHUB_TOKEN = "ghp_..."      # needs 'repo' scope (classic) or Contents:write (fine-grained)
#   powershell -File scripts\publish.ps1
#
# Optional: -Name <repo> -Owner <account> -Private
param(
  [string]$Name = 'dsh-notification-desktop',
  [string]$Owner = '',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
  throw 'GITHUB_TOKEN is not set. Create a token at https://github.com/settings/tokens (classic, scope: repo) and set it first.'
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'dsh-notification-desktop'
}

# 1. who are we
$me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
$login = $me.login
if ([string]::IsNullOrWhiteSpace($Owner)) { $Owner = $login }
Write-Host "authenticated as $login; target repo $Owner/$Name"

# 2. create the repo (idempotent)
$body = @{
  name        = $Name
  description = 'Turn-finished desktop notifications for DeepSeek Harness 0.2.x (host session projection + browser Notification).'
  private     = [bool]$Private
  has_issues  = $true
} | ConvertTo-Json
try {
  $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body
  Write-Host "created $($repo.html_url)"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 422) { Write-Host 'repository already exists; reusing it' }
  else { throw }
}

# 3. commit and push
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not (Test-Path '.git')) { git init -q -b main }
  git add -A
  $dirty = (git status --porcelain)
  if ($dirty) {
    git -c user.name="$login" -c user.email="$($me.id)+$login@users.noreply.github.com" `
        commit -q -m 'dsh-notification-desktop 0.2.0: 0.2.x port of dsh-notification'
  }
  $remote = "https://x-access-token:$token@github.com/$Owner/$Name.git"
  $existing = git remote get-url origin 2>$null
  if ($existing) { git remote set-url origin $remote } else { git remote add origin $remote }
  git push -q -u origin HEAD:main
  git remote set-url origin "https://github.com/$Owner/$Name.git"
} finally {
  Pop-Location
}

$slug = "$Owner/$Name"
Write-Host ""
Write-Host "pushed: https://github.com/$slug"
Write-Host "install into the desktop profile with:"
Write-Host "  dsh plugin --profile desktop add https://github.com/$slug/archive/refs/heads/main.tar.gz"
