import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { GraphRest } from './graph-rest.mjs';

// Shared native transport: no model turn or auth-file access. Each consumer owns its operation policy.
const allowed = new Set(['get_profile', 'list_mail_folders', 'list_messages']);
export class OutlookConnector {
  constructor(root) {
    this.cwd = path.join(root, 'workspace');
    const bin = process.env.MAIL_FLOW_CODEX_BIN || path.join(process.env.APPDATA,
      'npm/node_modules/@openai/codex/bin/codex.js');
    this.child = spawn(process.execPath, [bin, 'app-server', '--listen', 'stdio://', '-c', 'features.apps=true',
      '-c','mcp_servers.autocad-mcp.enabled=false','-c','mcp_servers.fusion.enabled=false','-c','mcp_servers.altium.enabled=false'],
      { cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.next = 0; this.pending = new Map(); this.failed = false;
    // stderr can contain private config; never copy it to logs or model input.
    this.child.stderr.resume();
    const fail = message => {
      this.failed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
      this.pending.clear();
    };
    this.child.on('error', () => fail('Cannot start native Codex app-server'));
    this.child.on('exit', code => fail(`Native app-server exited (${code}); existing login was not changed. If the host launch was restricted, request normal tool authorization; do not reset the mailbox login based on this exit alone.`));
    this.child.stdin.on('error', () => fail('Native app-server input closed'));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601,
          message: 'Connector client cannot approve interactive requests; ask the user' } }) + '\n');
      } else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`Native RPC ${p.method} failed (${msg.error.code}): ${String(msg.error.message || '').slice(0, 500)}`)) : p.resolve(msg.result);
      }
    });
  }
  #rpc(method, params = {}) {
    if (this.failed) throw new Error('Native connector is unavailable');
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; outcome may be unknown; no automatic retry`)); }, 45000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async start() {
    await this.#rpc('initialize', { clientInfo: { name: 'office-outlook', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await this.#rpc('thread/start', { cwd: this.cwd,
      approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: true });
    this.threadId = result.thread.id;
  }
  async tools() {
    const tools = []; let cursor;
    do {
      const page = await this.#rpc('mcpServerStatus/list', { threadId: this.threadId,
        serverName: 'codex_apps', detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
      for (const server of page.data) if (server.name === 'codex_apps') {
        if (server.toolsError) throw new Error(`Outlook tool discovery failed: ${server.toolsError.slice(0, 500)}`);
        for (const tool of Object.values(server.tools)) if (tool.name.startsWith('microsoft_outlook_email.')) tools.push(tool);
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!tools.length) throw new Error('No Outlook tools discovered; check the existing connector login; no login was changed');
    return tools;
  }
  async call(name, args = {}) {
    if (!/^microsoft_outlook_email\.[a-z][a-z0-9_]*$/.test(name)) throw new Error('Only the Outlook connector namespace is available');
    return await this.#rpc('mcpServer/tool/call', { threadId: this.threadId, server: 'codex_apps', tool: name, arguments: args });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    // Kill the owned tree before closing stdin: the launcher can otherwise exit first,
    // leaving native descendants/console pipe handles behind. Finish cleanup before returning.
    let error;
    if (process.platform === 'win32' && this.child.pid && this.child.exitCode === null) {
      const stopped = spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      // taskkill also fails when the process exited between the check and the kill: only a process that is still alive is a cleanup failure.
      if (stopped.error || stopped.status !== 0) {
        let alive = true; try { process.kill(this.child.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) error = new Error('Could not confirm connector process cleanup; inspect this invocation before retrying');
      }
    } else if (this.child.exitCode === null) this.child.kill();
    this.lines.close(); this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    if (error) throw error;
  }
}

// Unattended collection keeps a fixed read-only interface, without a raw RPC escape hatch.
export class OutlookReader {
  #connector;
  constructor(root) { this.#connector = new OutlookConnector(root); this.calls = 0; }
  async start() { await this.#connector.start(); }
  async call(name, args = {}) {
    if (!allowed.has(name)) throw new Error('Only read-only mail operations are available');
    this.calls++;
    const result = await this.#connector.call(`microsoft_outlook_email.${name}`, args);
    if (result.isError) throw new Error(`Outlook ${name} failed: ${outlookError(result)}; no automatic retry`);
    if (!result.structuredContent) throw new Error(`Outlook ${name} returned no structured data`);
    return result.structuredContent;
  }
  close() { this.#connector.close(); }
}
export function outlookError(result) {
  return (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 500) || 'connector returned isError=true';
}

// Unattended collection over the user's own Graph read login (mail read-login): no Codex/ChatGPT account involved.
// Same call(name,args) interface and response shapes as OutlookReader, so Flow.collect is unchanged.
const SELECT = 'id,subject,sender,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,webLink,hasAttachments';
export class GraphReader {
  #graph;
  constructor(root, account) { this.#graph = new GraphRest(root, account); this.calls = 0; }
  async start() { await this.#graph.start(); }
  async call(name, args = {}) {
    if (!allowed.has(name)) throw new Error('Only read-only mail operations are available');
    this.calls++;
    if (name === 'get_profile') {
      // start() already verified /me against the configured account; status.account is that verified identity.
      return { email: this.#graph.status.account };
    }
    if (name === 'list_mail_folders') return await this.#graph.request('GET', `/me/mailFolders?$top=${args.top || 200}`);
    const top = args.top || 20, skip = args.skip || 0;
    const q = [`$top=${top}`, `$skip=${skip}`, `$select=${SELECT}`];
    if (args.filter) q.push('$filter=' + encodeURIComponent(args.filter));
    if (args.order_by) q.push('$orderby=' + encodeURIComponent(args.order_by));
    const r = await this.#graph.request('GET', `/me/mailFolders/${encodeURIComponent(args.folder_id)}/messages?${q.join('&')}`);
    const value = r.value || [];
    return { value, has_more: !!r['@odata.nextLink'], next_from_index: skip + value.length };
  }
  close() { this.#graph.close(); }
}
