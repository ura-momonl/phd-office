export function bindPowerShell(defaultCwd) {
  const dialog=document.createElement('dialog');dialog.className='powershell-dialog';dialog.id='powershell-dialog';
  dialog.innerHTML=`<form><h2>运行 PowerShell</h2><p class="muted">将在本机打开普通 Windows PowerShell 5.1 窗口。输出、交互和 Ctrl+C 停止都在该窗口；不会自动提权。</p><label>起始目录<input name="cwd" aria-label="PowerShell 起始目录"></label><p class="muted">未指定时从办公室目录启动；完整路径及命令中的 cd / Set-Location 保持原样。</p><label>将执行的命令<textarea name="code" aria-label="PowerShell 命令" rows="9" readonly></textarea></label><p class="muted">命令可修改文件或访问网络，请核对后运行。这里只启动窗口，不判断命令执行是否成功。</p><p class="powershell-status" role="status" aria-live="polite"></p><div class="dialog-actions"><button type="submit" class="primary">确认运行</button><button type="button" class="secondary" data-close>取消</button></div></form>`;
  document.body.append(dialog);
  const form=dialog.querySelector('form'),cwd=form.elements.cwd,code=form.elements.code,run=form.querySelector('[type="submit"]'),close=form.querySelector('[data-close]'),status=dialog.querySelector('[role="status"]');
  let running=false;
  document.addEventListener('click',event=>{
    const button=event.target.closest('.md-run-powershell');if(!button || dialog.open)return;
    // Only assistant message code blocks can reach this action, not user quotes,
    // project documents or arbitrary raw HTML in a message.
    if(!button.closest('.message.assistant'))return;
    const text=button.closest('.md-code')?.querySelector('pre code')?.textContent;if(!text)return;
    code.value=text;cwd.value=defaultCwd;status.textContent='';run.disabled=false;close.textContent='取消';dialog.showModal();
  });
  close.onclick=()=>{if(!running)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(running)event.preventDefault();});
  form.onsubmit=async event=>{
    event.preventDefault();if(running || run.disabled)return;running=true;run.disabled=true;close.disabled=true;cwd.disabled=true;
    status.textContent='正在启动…';
    try {
      const response=await fetch('/api/powershell/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value,cwd:cwd.value.trim() || defaultCwd,confirmed:true})});
      const result=await response.json();if(!response.ok || result.error)throw new Error(result.error || '启动请求失败');
      status.textContent=`已启动 PowerShell 窗口（PID ${result.pid}）。请在窗口查看运行结果。`;close.textContent='关闭';
    }catch(error){status.textContent=error.message+'；不会自动重试。请检查是否已有窗口启动，再决定是否重试。';run.disabled=false;}
    finally{running=false;close.disabled=false;cwd.disabled=false;}
  };
}
