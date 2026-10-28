param(
  [ValidateSet('login','serve')][string]$Mode = 'serve',
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Account,
  [string]$StatusFile,
  [switch]$Calendar
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Use the project portable PowerShell 7; Windows PowerShell 5.1 Graph login failed in this office' }
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$module = Join-Path $Root '.runtime\mail-flow\graph-sdk\Microsoft.Graph.Authentication\2.41.2\Microsoft.Graph.Authentication.psd1'
if (!(Test-Path -LiteralPath $module)) { throw 'Official Graph authentication module is missing; see mail-flow/README.md' }
Import-Module -Name $module -ErrorAction Stop
Set-MgRequestContext -MaxRetry 0 -ClientTimeout 45 | Out-Null
# Official SDK owns encrypted credentials. Never export access/refresh tokens.
# Device authentication avoids launching an unmanaged browser when consent is needed.
function Save-LoginStatus($value) {
  if ($StatusFile) {
    $temporary = $StatusFile + '.tmp'
    [IO.File]::WriteAllText($temporary,($value | ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$StatusFile,$true)
  }
}
Save-LoginStatus @{state='starting'; at=[DateTime]::UtcNow.ToString('o')}
try {
  $scopes = @('Mail.ReadWrite','Mail.Send')
  if ($Calendar) { $scopes += 'Calendars.ReadWrite' }
  if ($Mode -eq 'login') {
    Connect-MgGraph -Scopes $scopes -UseDeviceAuthentication -ContextScope CurrentUser -NoWelcome
  } else {
    # A send session reuses the SDK's saved sign-in silently. Device authentication would ask for a new code every time and cannot be answered here.
    # Without the saved record the SDK would fall back to an interactive prompt, so stop first and let the user run mail graph-login.
    if (!(Test-Path -LiteralPath (Join-Path $HOME '.mg\mg.authrecord.json'))) { throw 'No saved Graph sign-in; run mail graph-login' }
    Connect-MgGraph -Scopes $scopes -ContextScope CurrentUser -NoWelcome
  }
  $context = Get-MgContext
  if ($context.Account -ine $Account) { throw 'Graph account does not match the configured mailbox; no mail operation performed' }
} catch {
  $codes = @([regex]::Matches($_.Exception.ToString(),'AADSTS\d+') | ForEach-Object Value | Select-Object -Unique)
  $reason = if ($_.Exception.ToString() -match 'timed out') {'login_timeout'} else {'login_failed'}
  Save-LoginStatus @{state='failed'; reason=$reason; diagnostic_codes=$codes; at=[DateTime]::UtcNow.ToString('o')}
  if ($StatusFile) { exit 1 }
  throw
}
$status = @{account=$context.Account; scopes=@($context.Scopes); max_retry=0}
Save-LoginStatus @{state='authenticated'; account=$context.Account; scopes=@($context.Scopes); at=[DateTime]::UtcNow.ToString('o')}
if ($Mode -eq 'login') { $status | ConvertTo-Json -Compress; exit 0 }
@{ready=$true; status=$status} | ConvertTo-Json -Compress -Depth 8
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    # Keep mail unchanged; calendar access is opt-in, create/read only, on this account.
    $mailAllowed = $request.path -match '^/me/messages/[^/?]+(?:/(createReply|createReplyAll|send))?(?:\?.*)?$' -and $request.method -in @('GET','POST','PATCH')
    $attachmentAllowed = $request.method -eq 'GET' -and $request.path -match '^/me/messages/(?:[A-Za-z0-9_-]|%2F|%2B|%3D|%25)+/attachments(?:/(?:[A-Za-z0-9_-]|%2F|%2B|%3D|%25)+)?(?:\?[^#\r\n]*)?$'
    $calendarAllowed = $Calendar -and (($request.method -eq 'POST' -and $request.path -ceq '/me/events') -or
      ($request.method -eq 'GET' -and $request.path -match '^/me/events/(?:[A-Za-z0-9_-]|%2F|%2B|%3D)+$'))
    if (!$mailAllowed -and !$attachmentAllowed -and !$calendarAllowed) { throw 'Unsupported Graph mail/calendar operation' }
    $headers = @{}
    if ($request.headers) { $request.headers.psobject.properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value } }
    $arguments = @{Method=$request.method; Uri=('https://graph.microsoft.com/v1.0'+$request.path); Headers=$headers; OutputType='PSObject'}
    if ($null -ne $request.body) {
      $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($request.body | ConvertTo-Json -Depth 50 -Compress))
      $arguments.ContentType = 'application/json; charset=utf-8'
    }
    $result = Invoke-MgGraphRequest @arguments
    @{id=$request.id; result=$result} | ConvertTo-Json -Depth 60 -Compress
  } catch {
    # Do not print provider exceptions, which can contain request bodies or headers.
    $code = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $code = [int]$_.Exception.Response.StatusCode }
    @{id=$request.id; error=@{message='Graph request failed; outcome may be unknown; do not retry a write'; status=$code}} | ConvertTo-Json -Compress
  }
}
