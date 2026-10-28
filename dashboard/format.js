// Values that reach the page go through one escaping function and one set of number/date formats,
// so a rule changed here changes every dashboard module at once.
export const esc=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const num=n=>Number(n || 0).toLocaleString('zh-CN');
// The usage page reports whole call counts; other pages print the stored number.
export const int=n=>Math.round(Number(n || 0)).toLocaleString('zh-CN');
// List timestamps drop the year; the answer-record dialog shows it. Both keep an explicit fallback
// for a value that is missing, so the caller decides what an absent date looks like.
export const when=(t,fallback='—')=>t ? new Date(t).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : fallback;
export const whenFull=(t,fallback='')=>t ? new Date(t).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : fallback;
