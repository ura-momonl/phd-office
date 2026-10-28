// UI descriptions expose purpose/file/command identity, not arbitrary inputs,
// script bodies, message bodies or command-line credential values.
const brief=value=>String(value || '').replace(/\s+/g,' ').replace(/(?:[A-Z]:[\\/])?Main[\\/]assistant[\\/]/gi,'');
const file=value=>brief(value).replace(/\\/g,'/');
export function toolSummary(name,input={}) {
  if(typeof input==='string'){try{input=JSON.parse(input);}catch{input={command:input};}}
  input ||= {};
  const target=input.file_path || input.path || input.filename;
  if(/^(Read|Edit|Write|fileChange)$/i.test(name)){
    const paths=input.changes?.map(c=>c.path).filter(Boolean).slice(0,3);
    return `${/^Read$/i.test(name)?'读取':/^Write$/i.test(name)?'写入':'修改'}文件${target || paths?.length ? ' · '+file(target || paths.join('、')) : ''}`;
  }
  if(input.description && !/(?:password|passwd|secret|token|api[_-]?key|authorization|bearer)\s*[:= ]/i.test(input.description))return brief(input.description);
  if(target)return '操作文件 · '+file(target);
  if(input.url){try{return '访问页面 · '+new URL(input.url).hostname;}catch{/* Do not publish malformed URL inputs. */}}
  const actions=input.commandActions?.filter(a=>a.type==='read' && (a.path || a.name));
  if(actions?.length)return '读取文件 · '+actions.slice(0,3).map(a=>file(a.path || a.name)).join('、');
  let command=input.commandActions?.map(a=>a.command).filter(Boolean).join('; ') || input.command || input.cmd || '';
  const wrapped=command.match(/\s-Command\s+(['"])([\s\S]*)\1\s*$/i);if(wrapped)command=wrapped[2];
  if(command.includes('\n') || /^\s*(?:@['"]|node\s+--input-type|python\s+-c)/i.test(command))return '执行内嵌脚本';
  const steps=command.split(/;\s*|&&\s*/).map(step=>{
    const s=step.trim();let m;
    if(/^node\s+scripts\/run-tests\.mjs(?:\s|$)/i.test(s)){const flags=s.match(/\s--[a-z-]+(?:=\d+)?/gi)?.map(x=>x.trim()).join(' ');return '运行隔离测试'+(flags ? ' · '+flags : '');}
    if((m=s.match(/^node\s+automation\/run\.mjs\s+([a-z-]+)(?:\s+([a-z-]+))?/i)))return '办公室命令 · '+m.slice(1).filter(Boolean).join(' ');
    if((m=s.match(/^node\s+--check\s+['"]?([^\s'"]+)/i)))return '语法检查 · '+file(m[1]);
    if((m=s.match(/^(?:node|python)\s+['"]?([^\s'"]+\.(?:m?js|py))(?:['"]|\s|$)/i)))return '运行脚本 · '+file(m[1]);
    if((m=s.replace(/\s-(?:Encoding|TotalCount|Tail)\s+\S+/gi,'').match(/^(Get-Content|Get-Item|Test-Path|cat|head|tail|ls|dir)\s+(?:-(?:LiteralPath|Path)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/i)))return (/Get-Content|cat|head|tail/i.test(m[1])?'读取文件':'查看路径')+' · '+file(m[2] || m[3] || m[4]);
    if(/^(?:rg|grep|Select-String)\s/i.test(s))return '检索文件内容';
    return '';
  }).filter(Boolean);
  if(steps.length)return [...new Set(steps)].slice(0,3).join('；');
  return command ? '执行命令 · '+(command.trim().match(/^[\w./\\-]+/)?.[0] || '脚本') : '调用工具 · '+brief(name);
}
