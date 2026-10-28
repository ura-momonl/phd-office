// Compose before approval/dispatch. No mailbox mutation, truncation, model call or invented headers.
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©',reg:'®',bull:'•',euro:'€'};
const decode=text=>text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(all,key)=>{
  if(key[0]!=='#')return entities[key.toLowerCase()]??all;
  const n=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return Number.isInteger(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):all;
});
// The connector's HTML-to-text leaves trailing blanks, runs of empty lines, **bold** header labels and "* * *" rules, and hard-wraps paragraphs near 78 columns.
// Tidy only that whitespace/markup; never drop or reword content. Unwrapping applies to HTML originals only: a plain-text original's own line breaks are the author's.
const joins=(line,next)=>line.length>=60&&next.trim()&&!/^[\s>]|^(?:[-*•]\s|\d+[.)]\s|(?:From|Sent|To|Cc|Subject|Date):)/.test(next);
function tidy(text,unwrap) {
  const lines=text.split('\n').map(l=>l.replace(/\s+$/,'').replace(/^\*\*(From|Sent|To|Cc|Subject|Date):\*\*\s*/,'$1: ').replace(/^(?:\* ){2,}\*$/,'________________________________'));
  const out=[];
  for(const line of lines) {
    if(!line&&(!out.length||!out.at(-1)))continue;
    const last=out.at(-1);
    if(unwrap&&last&&joins(last,line))out[out.length-1]=last+(/[A-Za-z]-$/.test(last)?'':' ')+line;
    else out.push(line);
  }
  while(out.length&&!out.at(-1))out.pop();
  return out.join('\n');
}
export function bodyText(body) {
  if(!body||typeof body.content!=='string'||!body.content.trim())throw new Error('Full original body is required; bodyPreview is not a quotation');
  let text=body.content.replace(/\r\n?/g,'\n');
  const html=String(body.contentType).toLowerCase()==='html';
  // The connector can label an already rendered text body "html". Keep that text verbatim (tidied below).
  if(html&&/<\/?(?:html|head|body|script|style|p|div|br|table|tr|td|li|a|span|b|strong|em|font|h[1-6])\b/i.test(text)) {
    text=text.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<!--[\s\S]*?-->/g,'')
      .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,url,label)=>`${label} (${url})`)
      .replace(/<br\b[^>]*>/gi,'\n').replace(/<li\b[^>]*>/gi,'\n- ')
      .replace(/<\/(?:p|div|li|tr|table|ul|ol|h[1-6])\s*>/gi,'\n').replace(/<\/(?:td|th)\s*>/gi,'\t')
      .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g,'');
    text=decode(text);
  }
  text=tidy(text,html);
  if(!text.trim())throw new Error('Original body has no readable text to quote');
  return text;
}
const header=value=>String(value||'').replace(/[\r\n]+/g,' ').trim();
const address=recipient=>{
  const a=recipient?.emailAddress||recipient?.email_address;
  if(!a)return typeof recipient==='string'?header(recipient):'';
  return a.name&&a.address?`${header(a.name)} <${header(a.address)}>`:header(a.address||a.name);
};
// Outlook's own wording, in the office's wall time: "Thursday, October 15, 2026 12:28 PM".
const when=iso=>{
  const d=new Date(iso);if(!iso||Number.isNaN(d.getTime()))return header(iso);
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(d).map(x=>[x.type,x.value]));
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} ${p.dayPeriod}`;
};
// Plain-text body only (the connector sends no HTML), so imitate Outlook's reply block: a rule, the original header, then the original text unprefixed.
// "Sent" only when the connector gave a sent time; a received time is never relabeled as sent.
export function quoteReply(original,text_content) {
  if(typeof text_content!=='string'||!text_content.trim())throw new Error('Reply text is required');
  const text=bodyText(original?.body);
  const recipients=list=>(Array.isArray(list)?list:[]).map(address).filter(Boolean).join('; ');
  const values=[['From',address(original.sender||original.from)],original.sentDateTime?['Sent',when(original.sentDateTime)]:['Received',when(original.receivedDateTime)],
    ['To',recipients(original.toRecipients)],['Cc',recipients(original.ccRecipients)],['Subject',header(original.subject)]];
  const headers=values.filter(([,value])=>value).map(([label,value])=>`${label}: ${value}`).join('\n');
  return text_content.replace(/\s+$/,'')+'\n\n________________________________\n'+headers+'\n\n'+text;
}
