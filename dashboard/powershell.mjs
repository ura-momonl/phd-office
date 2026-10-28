import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {root} from '../automation/files.mjs';

// A user-confirmed local console launch, not an agent tool or unattended runner.
export async function launchPowerShell({code,cwd=root,confirmed}={}) {
  if(confirmed!==true)throw new Error('请先核对命令和目录，再确认运行');
  if(typeof code!=='string' || !code.trim() || code.length>24000 || code.includes('\0'))throw new Error('命令不能为空，且最多 24000 字符');
  if(typeof cwd!=='string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())throw new Error('起始目录必须是存在的绝对目录');
  if(process.platform!=='win32')throw new Error('此入口只支持 Windows PowerShell');
  // EncodedCommand avoids shell argument interpolation and preserves Chinese,
  // quotes and multiline commands. Do not rewrite the user's code or bypass policy.
  const script=`Set-Location -LiteralPath '${cwd.replace(/'/g,"''")}'\n${code}`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const exe=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  // Start-Process owns the visible, independent console. A detached powershell
  // directly under the hidden backend can exit without ever creating a console.
  const literal=text=>`'${text.replace(/'/g,"''")}'`;
  const launcher=`$ErrorActionPreference='Stop'; Start-Process -FilePath ${literal(exe)} -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${encoded}') -WorkingDirectory ${literal(cwd)} -WindowStyle Normal -PassThru | Select-Object -ExpandProperty Id`;
  if(launcher.length>30000)throw new Error('命令超过 Windows 启动参数长度限制，请保存为 .ps1 文件后运行该文件');
  const pid=await new Promise((resolve,reject)=>{
    execFile(exe,['-NoLogo','-NoProfile','-Command',launcher],{cwd,windowsHide:true,encoding:'utf8'},(error,stdout,stderr)=>{
      if(error)return reject(new Error('PowerShell 启动失败：'+(stderr.trim() || error.message)));
      const pid=Number(stdout.trim());if(!Number.isSafeInteger(pid) || pid<=0)return reject(new Error('未收到 PowerShell 窗口进程号，请先检查是否已启动；不要自动重试'));
      resolve(pid);
    });
  });
  return {started:true,pid,cwd}; // Spawned is not completed or successful execution.
}
