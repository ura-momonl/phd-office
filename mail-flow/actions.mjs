import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { OutlookConnector, outlookError } from './outlook.mjs';
import { quoteReply } from './reply.mjs';
import {readAttachment,uploadAttachment} from './attachments.mjs';
import {mailGuide} from './guide.mjs';
import {GraphSession,sendNativeReply} from './graph.mjs';
import {GraphRest} from './graph-rest.mjs';
import {calendarTools,calendarEventBody,createCalendarEvent,fetchCalendarEvent} from './calendar-native.mjs';
import {downloadTools,listAttachments,downloadAttachment} from './downloads.mjs';

// Mail-sending tools: an identical send is refused by the program, not left to the assistant to remember.
const repeatGuarded = /^(reply_to_email|reply_native|send_email|send_email_on_behalf|forward_email|schedule_email|create_event_native)$/;
const repeatWindowMs = 24 * 3600000;
const sentFolderName = /^(sent( items| mail)?|已发送(邮件|项目)?)$/i;

// Explicit interactive access, not part of Flow.collect/apply or any scheduled loop.
export class OutlookActions {
  constructor(root,{attachmentUploader=uploadAttachment,nativeGraph}={}) {
    this.root = root;
    this.log = path.join(root, '.runtime/mail-flow/outlook-actions.jsonl');
    this.replies = path.join(root, '.runtime/mail-flow/prepared-replies');
    this.attachmentUploader=attachmentUploader;
    const configFile=path.join(root,'mail-flow/config.json');
    const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):{};
    this.account=config.account;
    this.graph=nativeGraph??(config.replyTransport==='graph'?new GraphRest(root,config.account,{kind:'send'}):null);
    // Reads use the Node transport: it is the one that works in the confined shell, and it only
    // holds Mail.Read. It only needs the configured mailbox, not the send transport: losing
    // replyTransport (or the SDK session) must not take attachment and body reads down with it.
    // Sending uses the same Node transport with its own login (mail send-login); only calendar still uses the SDK session.
    this.readGraph=nativeGraph??(config.account?new GraphRest(root,config.account):null);
    this.calendarGraph=nativeGraph??(this.graph?new GraphSession(root,config.account,{calendar:true}):null);
  }
  async start() {
    // Native Graph capabilities do not depend on the Codex/MCP connector.
    this.catalog = [];
    if(this.readGraph) {
      this.catalog.push(...structuredClone(downloadTools));
      this.catalog.push({name:'microsoft_outlook_email.fetch_native',description:'Read original/raw HTML or sent-copy details through Graph.',
        inputSchema:{type:'object',properties:{message_id:{type:'string'}},required:['message_id']},annotations:{readOnlyHint:true}});
    }
    if(this.graph) {
      this.catalog.push(...structuredClone(calendarTools));
      const properties={message_id:{type:'string'},text_content:{type:'string',description:'Only the approved new reply; Graph retains the native quote. No manually copied history.'},
        to:{type:'array'},cc:{type:'array'},bcc:{type:'array'},reply_all:{type:'boolean'}};
      this.catalog.push({name:'microsoft_outlook_email.reply_native',description:'Send an approved native HTML reply through Graph. Creates and verifies a native reply draft, then sends once; no automatic retry.',
        inputSchema:{type:'object',properties,required:['message_id','text_content']},annotations:{readOnlyHint:false}});
    }
  }
  async #loadTools(names = null) {
    // *_native is our local Graph namespace, not a connector capability. Reject
    // misspelled or disabled native tools before discovery, including mixed requests.
    // Never silently alias an unknown name to a real action.
    if(names)for(const name of names)if(name.endsWith('_native')&&!this.catalog.some(t=>t.name===`microsoft_outlook_email.${name}`)) {
      const available=this.catalog.filter(t=>t.name.endsWith('_native')).map(t=>t.name.split('.').at(-1));
      throw new Error(`Unknown or unavailable native Outlook tool: ${name}; ${available.length?'available native tools: '+available.join(', '):'native Graph tools require mail-flow/config.json replyTransport=graph'}. No connector discovery attempted for this invalid native name.`);
    }
    if(names && names.every(name=>this.catalog.some(t=>t.name===`microsoft_outlook_email.${name}`)))return;
    // Only connector-backed operations (or a full catalog request) start app-server.
    // Share discovery across parallel reads; a failed start is not automatically retried.
    await (this.connectorReady??=(async()=>{
      this.connector = new OutlookConnector(this.root);
      await this.connector.start();
      const tools = await this.connector.tools();
      this.catalog.push(...tools.filter(t=>!this.catalog.some(existing=>existing.name===t.name)));
    })());
  }
  async #graphReady() { return await (this.graphReady??=this.graph.start()); }
  async #readReady() { return await (this.readReady??=this.readGraph.start()); }
  async #calendarReady() { return await (this.calendarReady??=this.calendarGraph.start()); }
  async #connectorAccountReady() {
    if(!this.account)return;
    return await (this.connectorAccountReady??=(async()=>{
      const profile=await this.connector.call('microsoft_outlook_email.get_profile',{});
      const actual=profile.structuredContent?.email;
      if(profile.isError||typeof actual!=='string'||actual.toLowerCase()!==this.account.toLowerCase())
        throw new Error(`Outlook get_profile reports ${actual||'an unverified identity'}, but the configured mailbox is ${this.account}. Mailbox identity is not verified; reconnect/check the Outlook authorization. No requested mail read, upload or write dispatched.`);
    })());
  }
  async tools(name) {
    await this.#loadTools(name?[name]:null);
    const tools = this.catalog.filter(t => !name || t.name === `microsoft_outlook_email.${name}`);
    if (!tools.length) throw new Error(`Unknown Outlook tool: ${name}; use mail outlook-tools`);
    return tools.map(t=>{
      const fields=t._meta?.['openai/fileParams']||[],schema=structuredClone(t.inputSchema);
      for(const field of fields)if(schema.properties?.[field])schema.properties[field]={
        description:'Absolute local file path or array of paths. The office uploads approved files and supplies file references; do not pass base64 or signed URLs. Files must be smaller than 3 MB.',
        anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]};
      return {name:t.name.split('.').at(-1),description:t.description,
        ...(name?{inputSchema:schema,annotations:t.annotations,...(fields.length?{file_parameters:fields}: {})}:{}),
        requires_user_confirmation:this.requiresConfirmation(t)};
    });
  }
  requiresConfirmation(tool) {
    // Missing metadata is not proof of a read. Unknown/non-read operations require explicit authorization.
    return tool.annotations?.readOnlyHint !== true;
  }
  record(row) {
    fs.mkdirSync(path.dirname(this.log), { recursive: true });
    fs.appendFileSync(this.log, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  }
  #validate(request, readOnly = false) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(k => !['tool', 'args', 'confirmed_by_user', 'allow_repeat'].includes(k)) ||
        typeof request.tool !== 'string' || !request.args || typeof request.args !== 'object' || Array.isArray(request.args))
      throw new Error('Request must be {tool, args, confirmed_by_user?:true, allow_repeat?:true}; see help mail');
    const tool = this.catalog.find(t => t.name === `microsoft_outlook_email.${request.tool}`);
    if (!tool) throw new Error(`Unknown Outlook tool: ${request.tool}; use mail outlook-tools`);
    const schema = tool.inputSchema;
    for (const key of schema.required || []) if (!(key in request.args)) throw new Error(`Missing argument: ${key}`);
    // Do not silently drop a misspelled recipient or a field the tool cannot support.
    if (schema.properties) for (const key of Object.keys(request.args))
      if (!(key in schema.properties)) throw new Error(`Unsupported argument: ${key}; inspect mail outlook-tools ${request.tool}`);
    for(const field of tool._meta?.['openai/fileParams']||[])if(request.args[field]!=null){
      const paths=Array.isArray(request.args[field])?request.args[field]:[request.args[field]];
      if(paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('File parameters require absolute local paths, not base64 or file references');
      if(!this.requiresConfirmation(tool))throw new Error('File upload is available only for approved non-read-only actions');
    }
    if (request.allow_repeat != null && (request.allow_repeat !== true || !repeatGuarded.test(request.tool)))
      throw new Error('allow_repeat:true applies only to send/reply/forward/schedule tools and only when the user explicitly asked to repeat the action');
    if (readOnly && this.requiresConfirmation(tool))
      throw new Error('Preparation and verification accept only tools marked read-only; no writes are dispatched');
    if (this.requiresConfirmation(tool) && request.confirmed_by_user !== true)
      throw new Error('This operation needs user approval of the specific action and final parameters; then set confirmed_by_user:true. This flag does not obtain approval.');
    return tool;
  }
  // Latest status per action id: attempted/returned/unknown count as possibly sent; error does not.
  #priorSend(tool,argsHash,now=Date.now()) {
    if(!fs.existsSync(this.log))return null;
    const last=new Map();
    for(const line of fs.readFileSync(this.log,'utf8').split('\n')) {
      let r;try{r=JSON.parse(line);}catch{continue;}
      if(r.tool===tool&&r.args_sha256===argsHash&&now-Date.parse(r.at)<repeatWindowMs)last.set(r.id,r);
    }
    return [...last.values()].filter(r=>r.status!=='error').at(-1)||null;
  }
  async prepare(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(k => !['tools', 'reads', 'reply', 'sent'].includes(k)) ||
        !Array.isArray(request.tools) || request.tools.some(n => typeof n !== 'string' || !n) ||
        !Array.isArray(request.reads) || (request.sent != null && request.sent !== true))
      throw new Error('Preparation must be {tools:[short tool names], reads:[{tool,args}], reply?, sent?:true}');
    const hasReply=Object.hasOwn(request,'reply'),reply=request.reply;
    if(hasReply&&(!reply||typeof reply!=='object'||Array.isArray(reply)||
        Object.keys(reply).some(k=>!['message_id','text_content'].includes(k))||
        typeof reply.message_id!=='string'||!reply.message_id.trim()||typeof reply.text_content!=='string'||!reply.text_content.trim()))
      throw new Error('reply must be {message_id, text_content}; preparation never authorizes sending');
    const replyTool=this.graph?'reply_native':'reply_to_email',fetchTool=this.graph?'fetch_native':'fetch_message';
    const names = [...new Set([...request.tools,...(hasReply?[replyTool,fetchTool]:[])])];
    let requests=[...request.reads];
    if(hasReply&&!requests.some(r=>r?.tool===fetchTool&&r.args?.message_id===reply.message_id))
      requests.push({tool:fetchTool,args:{message_id:reply.message_id}});
    await this.#loadTools([...names,...requests.map(r=>r?.tool)].filter(n=>typeof n==='string'));
    const tools = (await Promise.all(names.map(name=>this.tools(name)))).flat();
    // Validate the entire group before dispatch. A confirmation flag cannot turn preparation into a write.
    for (const read of requests) this.#validate(read, true);
    // Only deduplicate after validation: never hide a malformed duplicate from the checks.
    let sourceSeen=false;
    requests=requests.filter(r=>{
      if(!hasReply||r.tool!==fetchTool||r.args.message_id!==reply.message_id)return true;
      if(sourceSeen)return false;
      sourceSeen=true;return true;
    });
    // Replies and sends need a sent-folder readback afterwards: find the folder in the same parallel round instead of a later search.
    // Graph replies already verify the exact sent copy by immutable ID. A folder
    // search would introduce an unrelated connector dependency into that path.
    const wantSent=hasReply&&!this.graph||request.sent===true;
    // A connector without the folder tool must not break preparation: the sent folder is a convenience, so report it missing.
    const foldersRead={tool:'list_mail_folders',args:{top:100}};
    let foldersReady=wantSent;
    if(wantSent)try{await this.#loadTools([foldersRead.tool]);this.#validate(foldersRead,true);}catch(error){foldersReady=false;var foldersNote=error.message;}
    const [reads,folders] = await Promise.all([Promise.all(requests.map(async read => {
      try { return { tool: read.tool, ...await this.call(read) }; }
      catch (error) { return { tool: read.tool, error: error.message }; }
    })),foldersReady?this.call(foldersRead).catch(error=>({error:error.message})):null]);
    const prepared={guidance:mailGuide(),tools,reads};
    if(hasReply&&this.graph)prepared.verification_mode='immutable_sent_copy';
    if(wantSent) {
      const found=folders?.result?.structuredContent?.value?.find(f=>f.well_known_name==='sentitems'||sentFolderName.test(f.display_name||''));
      if(found)Object.assign(prepared,{sent_folder:{id:found.id,name:found.display_name},
        // A starting point for the post-send readback: compare recipients, body and time yourself; it does not prove delivery.
        verify_template:{tool:'list_messages',args:{folder_id:found.id,order_by:'sentDateTime desc',top:3}}});
      else prepared.sent_folder_error=folders?.error||foldersNote||'No sent folder found in list_mail_folders; locate it before verification';
    }
    if(hasReply) {
      try {
        const source=reads[requests.findIndex(r=>r.tool===fetchTool&&r.args.message_id===reply.message_id)];
        if(source.error)throw new Error(source.error);
        const original=source.result?.structuredContent;
        if(original?.id!==reply.message_id)throw new Error('Original message ID does not match; no quoted reply prepared');
        if(this.graph&&(!original.body?.content||!original.from?.emailAddress?.address&&!original.sender?.emailAddress?.address))throw new Error('Full original body and sender are required');
        const text_content=this.graph?reply.text_content:quoteReply(original,reply.text_content);
        const action={tool:replyTool,args:{message_id:reply.message_id,text_content}};
        if(this.graph)Object.assign(action.args,{to:(original.replyTo?.length?original.replyTo:[original.from||original.sender]).map(r=>({email:r.emailAddress.address,...(r.emailAddress.name?{name:r.emailAddress.name}:{})})),cc:[],bcc:[]});
        fs.mkdirSync(this.replies,{recursive:true});
        const file=path.join(this.replies,`${randomUUID()}.json`);
        fs.writeFileSync(file,JSON.stringify(action,null,2)+'\n',{encoding:'utf8',flag:'wx'});
        // Check the actual artifact, not just the in-memory string. Never add approval here.
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));
        if(saved.tool!==action.tool||saved.args.message_id!==reply.message_id||saved.args.text_content!==text_content||
            Object.hasOwn(saved,'confirmed_by_user'))throw new Error('Prepared reply file did not match; no sendable reference returned');
        // The complete original stays visible once. MCP text can duplicate structuredContent.
        source.result={isError:false,structuredContent:original};
        prepared.reply_request_file=file;
        prepared.reply_preview={message_id:reply.message_id,text_content:reply.text_content,
          body_sha256:createHash('sha256').update(saved.args.text_content).digest('hex'),
          body_chars:saved.args.text_content.length,quote_verified:!this.graph,...(this.graph?{quote_mode:'server_native',to:action.args.to,cc:[],bcc:[]}: {})};
      } catch(error) {prepared.reply_error=error.message;}
    }
    return prepared;
  }
  async call(request) {
    await this.#loadTools([request?.tool,request?.verify?.tool].filter(n=>typeof n==='string'));
    const hasVerify = request && typeof request === 'object' && Object.hasOwn(request, 'verify');
    let action = request, verifyRequest;
    if (hasVerify) { const { verify, ...rest } = request; action = rest; verifyRequest = verify; this.#validate(verify, true); }
    const tool = this.#validate(action);
    request = action;
    // Metadata discovery and profile diagnostics remain usable even when the
    // existing connector reports another identity. Do not treat it as verified mail access.
    if(!request.tool.endsWith('_native')&&request.tool!=='get_profile')await this.#connectorAccountReady();
    const started=performance.now(),wireArgs={...request.args},attachments=[];
    // Program-side duplicate-send guard, checked before any upload or dispatch. An earlier attempt that errored does not block.
    const argsHash=createHash('sha256').update(JSON.stringify(request.args)).digest('hex');
    if(repeatGuarded.test(request.tool)&&request.allow_repeat!==true) {
      const prior=this.#priorSend(request.tool,argsHash);
      if(prior)throw new Error(`Identical ${request.tool} already ${prior.status} at ${prior.at} (action ${prior.id}); check the sent folder instead of resending. Only if the user explicitly asked to send it again, add allow_repeat:true`);
    }
    // Approval and verification gates precede every upload; validate/read every source before any network write.
    const groups=(tool._meta?.['openai/fileParams']||[]).filter(field=>request.args[field]!=null)
      .map(field=>({field,files:(Array.isArray(request.args[field])?request.args[field]:[request.args[field]]).map(readAttachment)}));
    for(const {field,files} of groups){
      wireArgs[field]=[];
      for(const file of files){wireArgs[field].push(await this.attachmentUploader(file,tool));attachments.push({name:file.name,size:file.size,sha256:file.sha256});}
    }
    const id = randomUUID(), write = this.requiresConfirmation(tool);
    if(request.tool==='create_event_native') {
      calendarEventBody(wireArgs,id);
      await this.#calendarReady();
      if(!this.calendarGraph.status?.scopes?.includes('Calendars.ReadWrite'))throw new Error('Calendar permission missing; run mail graph-login calendar');
    }
    // Record before dispatch: timeouts/crashes must not silently encourage a duplicate send. No bodies, tokens or attachment data.
    const row = { id, tool: request.tool, args_sha256: argsHash };
    if (write) this.record({ ...row, status: 'attempted' });
    let result;
    try {
      if(request.tool==='reply_native'){await this.#graphReady();result=await sendNativeReply(this.graph,wireArgs,draftId=>this.record({...row,status:'drafted',message_id:draftId}));}
      else if(request.tool==='create_event_native')result=await createCalendarEvent(this.calendarGraph,wireArgs,id);
      else if(request.tool==='fetch_event_native'){await this.#calendarReady();result=await fetchCalendarEvent(this.calendarGraph,wireArgs.event_id);}
      else if(request.tool==='fetch_native'){await this.#readReady();result={isError:false,structuredContent:await this.readGraph.request('GET','/me/messages/'+encodeURIComponent(wireArgs.message_id),undefined,{Prefer:'outlook.body-content-type="html"'}),content:[]};}
      else if(request.tool==='list_attachments_native'){await this.#readReady();result={isError:false,structuredContent:await listAttachments(this.readGraph,wireArgs.message_id),content:[]};}
      else if(request.tool==='download_attachment_native'){await this.#readReady();result={isError:false,structuredContent:await downloadAttachment(this.readGraph,this.root,wireArgs),content:[]};}
      else result = await this.connector.call(tool.name, wireArgs);
    }
    catch (e) { if (write) this.record({ ...row, status: 'unknown' }); throw e; }
    if (write) this.record({ ...row, status: result.isError ? 'error' : 'returned',
      message_id: result.structuredContent?.id || result.structuredContent?.message?.id || null });
    if (result.isError) throw new Error(`Outlook ${request.tool} failed: ${outlookError(result)}; no automatic retry; verify mailbox state before repeating a write`);
    // Some writes return text only. Do not turn a successful send into a false failure/retry.
    const outcome = { action_id: write ? id : null, result,...(attachments.length?{attachments}: {}) };
    if (hasVerify) {
      // Preserve the successful action independently of readback. No retry or delivery claim.
      try { outcome.verification = { status: 'returned', ...await this.call(verifyRequest) }; }
      catch (error) { outcome.verification = { status: 'error', error: error.message, no_automatic_retry: true }; }
    }
    outcome.duration_ms=Math.round(performance.now()-started);
    return outcome;
  }
  close() { try {if(this.calendarGraph!==this.graph)this.calendarGraph?.close();if(this.readGraph!==this.graph)this.readGraph?.close();this.graph?.close();} finally {this.connector?.close();} }
}
