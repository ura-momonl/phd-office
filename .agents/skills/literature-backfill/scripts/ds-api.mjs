// DeepSeek 阅读脚本的统一调用通道：跟随办公室设置（.runtime/deepseek-harness/provider.json）
// official      -> 官方 Key + https://api.deepseek.com/chat/completions，模型 deepseek-flash，思考用 thinking 字段
// commandcode   -> 套餐 Key + /chat/completions，模型 deepseek/deepseek-v4.1-flash，思考用 reasoning_effort（disabled 映射为 off）
// 只做通道与字段映射，不改判断口径；返回 {ok,status,json}，调用方照旧检查 r.ok / finish_reason。
import fs from 'node:fs';

const OFFICIAL = { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' };
const PLAN = { url: 'https://api.commandcode.ai/provider/v1/chat/completions', model: 'deepseek/deepseek-v4.1-flash' };

function readJson(path, why) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { throw Error(`读不到${why}：${path}（${e.message}）`); }
}

export function channelName() {
  try { return readJson('.runtime/deepseek-harness/provider.json', '通道设置').provider || 'official'; } catch { return 'official'; }
}

export function channel() {
  const name = channelName();
  if (name === 'commandcode') {
    const c = readJson('.runtime/commandcode/credentials.json', 'Command Code 凭据');
    if (!c.api_key) throw Error('Command Code 凭据缺少 api_key');
    return { name, ...PLAN, headers: { Authorization: 'Bearer ' + c.api_key } };
  }
  const c = readJson('.runtime/deepseek-harness/credentials.json', '官方凭据');
  if (!c.api_key) throw Error('官方凭据缺少 api_key');
  return { name: 'official', ...OFFICIAL, headers: { Authorization: 'Bearer ' + c.api_key } };
}

function mapUsage(j) {
  const u = j.usage || {};
  if (u.prompt_cache_hit_tokens == null && u.prompt_tokens_details) {
    const cached = u.prompt_tokens_details.cached_tokens || 0;
    u.prompt_cache_hit_tokens = cached;
    u.prompt_cache_miss_tokens = Math.max(0, (u.prompt_tokens || 0) - cached);
  }
  if (u.completion_tokens == null && u.total_tokens != null && u.prompt_tokens != null) u.completion_tokens = u.total_tokens - u.prompt_tokens;
  return j;
}

// body 用官方写法传进来（model/thinking/…），这里按通道翻译。
export async function postChat(body, timeoutMs = 300000) {
  const ch = channel();
  const out = { ...body, model: ch.model };
  if (ch.name === 'commandcode') {
    if (body.thinking && body.thinking.type === 'disabled') out.reasoning_effort = 'off';
    else if (body.thinking && body.thinking.type === 'enabled') out.reasoning_effort = body.reasoning_effort || 'high';
    delete out.thinking;
  }
  const r = await fetch(ch.url, {
    method: 'POST',
    headers: { ...ch.headers, 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(out),
  });
  if (!r.ok) return { ok: false, status: r.status, text: async () => (await r.text()).slice(0, 300) };
  const j = mapUsage(await r.json());
  return { ok: true, status: r.status, json: async () => j };
}
