import {Marked} from './vendor/markdown/marked.js';
import DOMPurify from './vendor/markdown/purify.js';
import katex from './vendor/markdown/katex.js';
import {canOpenInDefaultApp} from './local-file-types.js';

const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mathPattern=/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$((?:\\.|[^\\\n$])+?)\$(?!\d))/;
function mathToken(source) {
  const match=mathPattern.exec(source);
  if(!match)return;
  const text=match.slice(1).find(x=>x!==undefined);
  // A single-dollar closer must not follow whitespace (avoids ordinary currency).
  if(match[4]!==undefined && /(^\s|\s$)/.test(text))return;
  return {type:'math',raw:match[0],text,display:match[1]!==undefined || match[2]!==undefined};
}
function renderMath(token) {
  return katex.renderToString(token.text,{displayMode:token.display,throwOnError:false,trust:false,maxExpand:1000,maxSize:20});
}
// Local files named in chat (file:///D:/x, D:\x) open through the dashboard's own
// read-only endpoint; browsers refuse file: links from a web page. The server decides what is allowed.
const winPath=/^[A-Za-z]:[\\/][^\n<>"|?*]*$/;
function localPath(value) {
  const text=String(value ?? '').trim();
  if(/^file:\/\/\//i.test(text)){try {return decodeURIComponent(text.slice(8).split(/[?#]/)[0]).replace(/\//g,'\\');} catch {return null;}}
  if(winPath.test(text))return text;
  // Marked percent-encodes backslashes in link targets (D:%5CMain%5Cx).
  if(/^[A-Za-z]:%5C/i.test(text)){try {const decoded=decodeURIComponent(text);return winPath.test(decoded) ? decoded : null;} catch {return null;}}
  return null;
}
// Keep a browser href for documents; only a plain click on this PC launches the
// default app. A final segment without an extension keeps the Explorer control.
// An all-digit "extension" (IP address 100.1.2.3, version 2.5) is a name, not a file type.
const isFile=file=>/\.(?=[A-Za-z0-9]{1,8}$)[0-9]*[A-Za-z][A-Za-z0-9]*$/.test(file);
const openHref=file=>'/api/local-file?path='+encodeURIComponent(file);
const nativeAttrs=file=>canOpenInDefaultApp(file) ? ` class="md-native-file" data-path="${escape(file)}" title="用 Windows 默认软件打开；Ctrl+点击可在浏览器查看或下载"` : '';
const openLink=file=>isFile(file)
  ? `<a class="md-open-path${canOpenInDefaultApp(file) ? ' md-native-file' : ''}" data-path="${escape(file)}" href="${escape(openHref(file))}" target="_blank" rel="noopener noreferrer" title="${canOpenInDefaultApp(file) ? '用 Windows 默认软件打开；Ctrl+点击可在浏览器查看或下载' : '在浏览器预览或下载，不执行文件'}">打开 ↗</a>`
  : `<button type="button" class="md-open-path md-reveal-path" data-path="${escape(file)}" title="在 Windows 资源管理器中打开">打开 ↗</button>`;

// Repair office links at rendering time too: old localhost URLs must refer to
// the office server, not to a phone's own localhost. External sites stay intact.
function officeLink(value) {
  try {
    const base=location.origin;
    const url=new URL(value,base);
    const localHost=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if(url.username || url.password || !/^https?:$/.test(url.protocol) || !(url.origin===base || localHost && url.port==='8787'))return null;
    if(url.pathname==='/api/local-file') {
      const file=localPath(url.searchParams.get('path'));return file ? {file,href:openHref(file)} : null;
    }
    if(url.pathname.startsWith('/workspace/'))return {url:url.pathname,href:url.pathname+url.search,filename:decodeURIComponent(url.pathname)};
  } catch { /* Malformed URLs keep the ordinary sanitized link behavior. */ }
  return null;
}
const markdown=new Marked({gfm:true,breaks:true,renderer:{
  // Raw HTML stays visible as text; Markdown is never permission to run HTML.
  html:token=>escape(token.text),
  code:token=>{const lang=(token.lang || '').split(/\s/)[0],file=localPath(token.text);return `<div class="md-code"><div class="md-code-bar"><span>${escape(lang || '代码')}</span><div class="md-code-actions">${/^(powershell|pwsh|ps1)$/i.test(lang) ? '<button type="button" class="md-run-powershell">运行 ↗</button>' : ''}${file ? openLink(file) : ''}<button type="button" class="md-copy">复制</button></div></div><pre><code>${escape(token.text)}</code></pre></div>`;},
  codespan(token) {const file=localPath(token.text);return `<code>${escape(token.text)}</code>${file ? ' '+openLink(file) : ''}`;},
  link(token) {
    const office=officeLink(token.href),file=localPath(token.href) || office?.file,inner=this.parser.parseInline(token.tokens);
    if(file && !isFile(file))return `<a href="#" class="md-reveal-path" data-path="${escape(file)}" title="在 Windows 资源管理器中打开">${inner}</a>`;
    const attrs=file ? nativeAttrs(file) : office && canOpenInDefaultApp(office.filename) ? ` class="md-native-file" data-url="${escape(office.url)}" title="用 Windows 默认软件打开；Ctrl+点击可在浏览器查看或下载"` : '';
    return `<a href="${escape(file ? openHref(file) : office?.href || token.href)}"${attrs} target="_blank" rel="noopener noreferrer">${inner}</a>`;
  },
  // Only explicit chat attachments load images; Markdown images become links.
  image:token=>`<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${escape(token.text || '图片')}</a>`
},extensions:[
  {name:'blockMath',level:'block',start:source=>source.search(/^(?:\$\$|\\\[)/m),
    tokenizer(source) {
      if(!/^(?:\$\$|\\\[)/.test(source))return;
      const token=mathToken(source);if(!token)return;
      const rest=source.slice(token.raw.length);if(rest && !/^\s*(?:\n|$)/.test(rest))return;
      return {...token,type:'blockMath'};
    },renderer:token=>`<div class="md-math">${renderMath(token)}</div>\n`},
  {name:'math',level:'inline',start:source=>source.search(/\$|\\[([]/),tokenizer:mathToken,renderer:renderMath}
]});

// The only HTML-producing entry point for chat and handoffs. Fresh KaTeX options
// keep macros isolated between messages; sanitation includes its MathML/SVG.
export function renderMarkdown(text,{allowPowerShell=false}={}) {
  const html=markdown.parse(String(text ?? ''));
  return DOMPurify.sanitize(allowPowerShell ? html : html.replace(/<button type="button" class="md-run-powershell">运行 ↗<\/button>/g,''),{FORBID_TAGS:['img','style'],FORBID_ATTR:['id','name'],ADD_ATTR:['target']});
}

export async function copyCode(button) {
  const code=button.closest('.md-code')?.querySelector('pre code');if(!code)return;
  try {await navigator.clipboard.writeText(code.textContent);button.textContent='已复制 ✓';}
  catch {button.textContent='复制失败，请选中文本';}
}

// Explorer is a local action, so the server accepts it only from this same-origin page.
document.addEventListener('click',async event=>{
  const target=event.target.closest?.('.md-reveal-path,.md-native-file');if(!target)return;
  const native=target.classList.contains('md-native-file');
  if(native && (event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey))return;
  // Explorer opens on the computer, so it cannot work from a phone reaching it over the tailnet.
  if(!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)){
    if(native)return; // On phones the existing href is a preview/download, not a desktop action.
    event.preventDefault();alert('这是电脑上的文件夹，手机上不能打开。');return;
  }
  event.preventDefault();
  if(target.dataset.opening==='1')return;
  target.dataset.opening='1';
  const isButton=target.tagName==='BUTTON',label=target.textContent;
  try {
    const response=await fetch(native ? '/api/local-file/open' : '/api/local-file/reveal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(target.dataset.url ? {url:target.dataset.url} : {path:target.dataset.path})});
    const data=await response.json();if(!response.ok)throw new Error(data.error || '失败');
    if(isButton)target.textContent='已发出 ✓';
  } catch(error) {if(isButton)target.textContent='失败：'+error.message;else alert('无法打开'+(native ? '默认软件' : '资源管理器')+'：'+error.message);}
  finally {delete target.dataset.opening;}
  if(isButton)setTimeout(()=>{target.textContent=label;},2500);
});
