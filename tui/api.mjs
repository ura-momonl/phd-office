// Thin client for the Workbench backend. The TUI keeps no conversation state of its own.
export const base = () => `http://127.0.0.1:${Number(process.env.PHD_DASHBOARD_PORT || 8787)}`;

async function json(r) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

export const getState = (sessionId, signal) =>
  fetch(`${base()}/api/state?page=chat${sessionId ? '&session=' + encodeURIComponent(sessionId) : ''}`, { signal: signal ?? AbortSignal.timeout(15000) }).then(json);

export const search = (q, limit = 8) =>
  fetch(`${base()}/api/chat/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(8000) }).then(json);

const post = (path, body, headers = {}) =>
  fetch(base() + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }).then(json);

// The user chat entry accepts the TUI through its own client header (no browser Origin).
export const sendChat = ({ text, session_id, project_id, workdir }) =>
  post('/api/chat', { text, session_id: session_id || undefined, project_id: project_id || undefined, workdir: workdir || undefined }, { 'x-phd-client': 'tui' });
export const health = () => fetch(`${base()}/health`, { signal: AbortSignal.timeout(4000) }).then(json);
export const restartBackend = () => post('/api/backend/restart', {});
export const stop = task_id => post('/api/stop', { task_id }); // the backend aborts a running turn and cancels a queued one
export const markRead =read_at => post('/api/chat/read', { read_at });
export const pin = (session_id, pinned) => post('/api/chat/pin', { session_id, pinned });
