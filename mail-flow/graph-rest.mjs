import fs from 'node:fs';
import path from 'node:path';

// Read-only mail over Node's TLS stack.
// The PowerShell SDK path (mail-flow/graph-session.ps1) needs Schannel client credentials and a
// child process with piped stdio. The confined office shell has neither: every Schannel https
// call fails with SEC_E_NO_CREDENTIALS and node spawn with pipes returns EPERM, so the SDK session
// never prints its device code and silently retries. Node's fetch works there, so read-only mail
// (original bodies, attachments, inline images) uses this transport and its own device-code login.
// kind 'read' carries Mail.Read only and refuses every non-GET request. kind 'send' is the same
// transport with its own login (Mail.ReadWrite + Mail.Send) for the approved native reply, limited to
// the message/createReply/send paths; it needs neither the SDK session nor any ChatGPT/Codex account.
// Calendar keeps the official SDK session.
export const READ_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const SCOPES = {read:'https://graph.microsoft.com/Mail.Read offline_access openid profile',
  send:'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access openid profile'};
const SCOPE_NAMES = {read:['Mail.Read'],send:['Mail.ReadWrite','Mail.Send']};
const SEND_PATH = /^\/me\/messages\/[^/?]+(?:\/(?:createReply|createReplyAll|send))?(?:\?.*)?$/;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const paths = (root,kind='read') => ({pending:path.join(root,`.runtime/mail-flow/graph-${kind}-login.json`),
  token:path.join(root,`.runtime/mail-flow/graph-${kind}-token.json`)});
const tenantOf = account => String(account).split('@')[1] || 'common';
const identity = account => String(account || '').trim().toLowerCase();
const aadsts = text => [...String(text || '').matchAll(/AADSTS\d+/g)].map(m => m[0]).slice(0,3);
const writeJSON = (file,value) => fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});
const readJSON = file => JSON.parse(fs.readFileSync(file,'utf8'));
function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if(!part) return null;
  try { return JSON.parse(Buffer.from(part,'base64url').toString('utf8')); } catch { return null; }
}
async function form(fetchImpl,url,fields) {
  const response = await fetchImpl(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(fields),signal:AbortSignal.timeout(30000)});
  const body = await response.json().catch(() => ({}));
  return {response,body};
}

// Reuses a live device code so a second turn never asks the user for another code.
export async function startReadLogin(root,account,{fetchImpl=fetch,now=Date.now,kind='read'}={}) {
  const file = paths(root,kind).pending;
  if(fs.existsSync(file)) {
    const live = readJSON(file);
    if(identity(live.account) === identity(account) && live.expires_at > now() + 30000)
      return {state:'waiting_for_user',reused:true,user_code:live.user_code,verification_uri:live.verification_uri,
        expires_in:Math.max(0,Math.round((live.expires_at - now())/1000))};
  }
  const {response,body} = await form(fetchImpl,`https://login.microsoftonline.com/${tenantOf(account)}/oauth2/v2.0/devicecode`,
    {client_id:READ_CLIENT_ID,scope:SCOPES[kind]});
  if(!response.ok || typeof body.device_code !== 'string' || !/^[A-Z0-9]{6,}$/.test(String(body.user_code || '')) ||
    typeof body.verification_uri !== 'string')
    throw new Error(`Microsoft did not return a device code (HTTP ${response.status}${aadsts(body.error_description).length?', '+aadsts(body.error_description).join(','):''}); no login started`);
  const expires = Math.max(60,Number(body.expires_in) || 900);
  writeJSON(file,{account,device_code:body.device_code,user_code:body.user_code,verification_uri:body.verification_uri,
    expires_at:now() + expires*1000,interval:Math.max(2,Number(body.interval) || 5)});
  return {state:'waiting_for_user',user_code:body.user_code,verification_uri:body.verification_uri,expires_in:expires};
}

// Bounded polling: the caller decides how long to wait, nothing keeps running in the background.
export async function pollReadLogin(root,account,{waitSeconds=0,fetchImpl=fetch,now=Date.now,kind='read',
  sleep=ms => new Promise(resolve => setTimeout(resolve,ms))}={}) {
  const {pending,token} = paths(root,kind);
  if(!fs.existsSync(pending)) {
    if(fs.existsSync(token)) {
      const saved = readJSON(token);
      if(identity(saved.account) === identity(account)) return {state:'authenticated',account:saved.account};
      return {state:'other_account',account:saved.account,expected:account};
    }
    return {state:'not_started'};
  }
  const record = readJSON(pending);
  if(identity(record.account) !== identity(account))
    return {state:'other_account',account:record.account,expected:account,user_code:record.user_code};
  const deadline = now() + Math.max(0,Number(waitSeconds) || 0)*1000;
  for(;;) {
    if(now() > record.expires_at) { fs.rmSync(pending,{force:true}); return {state:'expired'}; }
    const {response,body} = await form(fetchImpl,`https://login.microsoftonline.com/${tenantOf(account)}/oauth2/v2.0/token`,
      {grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:READ_CLIENT_ID,device_code:record.device_code});
    if(response.ok && typeof body.refresh_token === 'string') {
      const claimed = decodeIdToken(body.id_token);
      const actual = claimed?.preferred_username || claimed?.upn || claimed?.unique_name || claimed?.email || null;
      if(actual && identity(actual) !== identity(account))
        throw new Error(`Microsoft signed in ${actual}, not the configured mailbox ${account}; the sign-in was discarded and no mail was read`);
      writeJSON(token,{account:actual || account,refresh_token:body.refresh_token,
        scopes:String(body.scope || '').split(' ').filter(Boolean),obtained_at:new Date().toISOString()});
      fs.rmSync(pending,{force:true});
      return {state:'authenticated',account:actual || account};
    }
    const error = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    if(error === 'authorization_pending') {
      if(now() >= deadline) return {state:'waiting_for_user',user_code:record.user_code,verification_uri:record.verification_uri,
        expires_in:Math.max(0,Math.round((record.expires_at - now())/1000))};
      await sleep(record.interval*1000);
      continue;
    }
    if(error === 'slow_down') { record.interval += 5; await sleep(record.interval*1000); continue; }
    fs.rmSync(pending,{force:true});
    if(error === 'expired_token') return {state:'expired'};
    if(error === 'authorization_declined' || error === 'access_denied') return {state:'declined'};
    return {state:'failed',error,diagnostic_codes:aadsts(body.error_description)};
  }
}

async function readAccessToken(root,account,{fetchImpl,kind='read'}) {
  const {token} = paths(root,kind);
  const login = kind === 'send' ? 'mail send-login' : 'mail read-login';
  if(!fs.existsSync(token))
    throw new Error(`No mail ${kind} sign-in yet; run node automation/run.mjs ${login}, finish the Microsoft device login, then retry; nothing was read or sent`);
  const saved = readJSON(token);
  if(identity(saved.account) !== identity(account))
    throw new Error(`Mail ${kind} sign-in belongs to ${saved.account}, not the configured mailbox ${account}; nothing was read or sent`);
  const {response,body} = await form(fetchImpl,`https://login.microsoftonline.com/${tenantOf(account)}/oauth2/v2.0/token`,
    {grant_type:'refresh_token',client_id:READ_CLIENT_ID,refresh_token:saved.refresh_token,scope:SCOPES[kind]});
  if(!response.ok || typeof body.access_token !== 'string') {
    if(body.error === 'invalid_grant')
      throw new Error(`Mail ${kind} sign-in expired or was revoked; run node automation/run.mjs ${login} again; nothing was read or sent`);
    throw new Error(`Mail ${kind} token refresh failed (${body.error || `HTTP ${response.status}`}); nothing was read or sent, no automatic retry`);
  }
  if(typeof body.refresh_token === 'string' && body.refresh_token !== saved.refresh_token)
    writeJSON(token,{...saved,refresh_token:body.refresh_token,obtained_at:new Date().toISOString()});
  return body.access_token;
}

// Same request interface as GraphSession, so mail helpers do not know which transport they use.
export class GraphRest {
  constructor(root,account,{fetchImpl=fetch,kind='read'}={}) { this.root=root;this.account=account;this.fetchImpl=fetchImpl;this.kind=kind;this.token=null;this.status=null; }
  async start() {
    if(process.env.PHD_ISOLATED_TESTS && this.fetchImpl === fetch)
      throw new Error('Real mail read login is disabled in isolated tests');
    this.token = await readAccessToken(this.root,this.account,{fetchImpl:this.fetchImpl,kind:this.kind});
    const me = await this.#get('/me?$select=mail,userPrincipalName');
    const actual = String(me?.mail || me?.userPrincipalName || '').toLowerCase();
    if(!actual || actual !== identity(this.account))
      throw new Error(`Mail read token belongs to ${actual || 'an unknown account'}, not the configured mailbox ${this.account}; no mail read`);
    this.status = {account:actual,scopes:SCOPE_NAMES[this.kind]};
    return this.status;
  }
  async #call(method,url,body,headers={}) {
    if(!this.token) throw new Error('Mail transport is not signed in');
    const init = {method,headers:{Authorization:'Bearer '+this.token,...headers},signal:AbortSignal.timeout(45000)};
    if(body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json; charset=utf-8'; }
    const response = await this.fetchImpl(GRAPH + url,init);
    const login = this.kind === 'send' ? 'mail send-login' : 'mail read-login';
    if(response.status === 401) throw new Error(`Mail ${this.kind} token was rejected; run node automation/run.mjs ${login}; nothing was read or sent`);
    if(!response.ok) throw Object.assign(new Error(`Graph mail ${method} failed (HTTP ${response.status}); no automatic retry`),{status:response.status});
    return response.status === 202 || response.status === 204 ? {} : await response.json();
  }
  async #get(url,headers={}) { return await this.#call('GET',url,undefined,headers); }
  request(method,url,body,headers={}) {
    const verb = String(method).toUpperCase();
    if(this.kind === 'send') {
      if(!['GET','POST','PATCH'].includes(verb) || !SEND_PATH.test(String(url)))
        return Promise.reject(new Error('Unsupported Graph send operation'));
      return this.#call(verb,url,body,headers);
    }
    if(verb !== 'GET')
      return Promise.reject(new Error('The read-only mail transport cannot send or modify mail; use mail send-login for the send transport'));
    if(!String(url).startsWith('/me/')) return Promise.reject(new Error('Unsupported Graph read path'));
    return this.#get(url,headers);
  }
  close() { this.token = null; }
}
