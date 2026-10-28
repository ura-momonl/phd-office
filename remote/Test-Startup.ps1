$ErrorActionPreference = 'Stop'
if ($env:PHD_ISOLATED_TESTS -ne '1') { throw 'Only run this in the sanitized test copy.' }
. (Join-Path $PSScriptRoot 'Backend.ps1')
$original = [IO.File]::ReadAllText($discordEntry)
$envPath = Join-Path $discordRoot '.runtime/discord.env'
try {
    # Replace only the isolated CLI with a no-network, no-model fixture using the real launch argv and lock.
    [IO.File]::WriteAllText($discordEntry, @'
import fs from 'node:fs';
fs.mkdirSync('.runtime/remote',{recursive:true});
const p='.runtime/remote/bridge.lock';
fs.writeFileSync(p,String(process.pid),{flag:'wx'});
process.once('exit',()=>{if(fs.existsSync(p))fs.unlinkSync(p);});
console.log('Discord commands ready.');
setInterval(()=>{},10000);
'@)
    [IO.File]::WriteAllText($envPath, '# fictional fixture; no token')
    # A lock left by a process that no longer exists (reboot) must not block the next launch.
    New-Item -ItemType Directory -Path (Split-Path -Parent $discordLock) -Force | Out-Null
    [IO.File]::WriteAllText($discordLock, '2147483000')
    Start-DiscordBridge
    $first = Get-DiscordBridge
    if (-not $first -or $first.MainWindowHandle -ne 0) { throw 'Hidden bridge not observed.' }
    Start-DiscordBridge
    $second = Get-DiscordBridge
    if ($first.Id -ne $second.Id) { throw 'Duplicate start changed the owner.' }
    Stop-DiscordBridge
    if (Test-Path -LiteralPath $discordLock) { throw 'Stopped bridge lock was retained.' }
    Start-DiscordBridge
    $third = Get-DiscordBridge
    if (-not $third -or $third.Id -eq $first.Id) { throw 'A later start failed.' }
    Stop-DiscordBridge
    Write-Output 'DISCORD LIFECYCLE PASSED'
} finally {
    if (Test-Path -LiteralPath $discordLock) { Stop-DiscordBridge }
    [IO.File]::WriteAllText($discordEntry, $original)
    if (Test-Path -LiteralPath $envPath) { Remove-Item -LiteralPath $envPath }
}
