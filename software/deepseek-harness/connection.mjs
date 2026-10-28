import path from 'node:path';
import fs from 'node:fs';
import {root,read,write} from '../../automation/files.mjs';

export function connectionStatus(provider=read('.runtime/deepseek-harness/provider.json',{provider:'official'}).provider) {
  if(!['official','commandcode'].includes(provider))throw new Error('deepseek provider official|commandcode');
  const file=provider==='commandcode' ? '.runtime/commandcode/credentials.json' : '.runtime/deepseek-harness/credentials.json';
  let configured=false;
  if(fs.existsSync(path.join(root,file))) {
    try {
      const c=read(file);configured=typeof c.api_key==='string' && !!c.api_key.trim() &&
        (provider!=='commandcode' || c.base_url==='https://api.commandcode.ai/provider/v1');
    } catch { /* Never echo a broken credentials file. */ }
  }
  return {transport:provider,credential_file:file,credential_configured:configured};
}

export function selectConnection(provider) {
  const status=connectionStatus(provider);
  if(!status.credential_configured)throw new Error('所选通道的本地凭据未配置或格式无效');
  write('.runtime/deepseek-harness/provider.json',{provider});
  return status;
}
