import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, '.runtime', 'state', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
// Official device-code login prepared this profile in OpenClaw's auth store.
// Auth-store profiles need not appear in config.auth.profiles.
config.auth = { ...config.auth, order: { ...config.auth?.order, openai: ['openai:assistant'] } };
const workspace = path.join(root, 'workspace');
for (const name of ['inbox', 'outbox', 'memory']) {
  fs.mkdirSync(path.join(workspace, name), { recursive: true });
}
Object.assign(config.agents.defaults, {
  workspace,
  skipBootstrap: true,
  model: 'openai/gpt-6-astra',
  models: { 'openai/gpt-6-astra': { agentRuntime: { id: 'codex' } } },
  maxConcurrent: 1,
  timeoutSeconds: 900,
  heartbeat: { every: '0m' },
});
config.agents.entries.main.identity = { name: '黎米的工作助手' };
config.plugins.entries.codex = {
  enabled: true,
  config: {
    codexDynamicToolsLoading: 'searchable',
    sessionCatalog: { enabled: false },
    codexPlugins: {
      enabled: true,
      allow_all_plugins: false,
      allow_destructive_actions: false,
      plugins: {
        'outlook-email@openai-curated-remote': {
          enabled: true,
          marketplaceName: 'openai-curated-remote',
          pluginName: 'outlook-email',
          allow_destructive_actions: false,
        },
      },
    },
    appServer: {
      homeScope: 'agent',
      mode: 'guardian',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    },
  },
};
config.plugins.entries.workboard = { enabled: true, config: {} };
config.plugins.entries['memory-core'] = {
  enabled: true,
  config: { dreaming: { enabled: false } },
};
config.skills = {
  ...config.skills,
  workshop: {
    ...config.skills?.workshop,
    autonomous: { mode: 'off' },
  },
};
config.tools = {
  profile: 'coding',
  alsoAllow: ['workboard', 'automations'],
  fs: { workspaceOnly: true },
};
config.gateway = {
  ...config.gateway,
  mode: 'local',
  bind: 'loopback',
  port: 18789,
  auth: {
    mode: 'token',
    token: config.gateway?.auth?.token || crypto.randomBytes(32).toString('hex'),
  },
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('Assistant configuration saved; credentials are not printed.');
