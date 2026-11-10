// Status of a coding agent: Claude Code and Codex are read from their session
// logs (nothing is changed in their settings); Cursor reports through a local
// hook endpoint because it keeps no readable log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOOK_PORT = 47800;
const SOURCES = {
  claude: { dir: path.join(os.homedir(), '.claude', 'projects'), depth: 2 },
  codex: { dir: path.join(os.homedir(), '.codex', 'sessions'), depth: 4 },
};
const DONE_VISIBLE_MS = 10 * 60 * 1000;

function newestLog(dir, depth) {
  let best = null;
  const walk = (d, left) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (left > 0) walk(p, left - 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.mtime) best = { file: p, mtime: m };
      } catch {}
    }
  };
  walk(dir, depth);
  return best;
}

function tailEntries(file) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const out = [];
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
    if (out.length >= 12) break;
  }
  return out; // newest first
}

function readClaude(file, age) {
  const last = tailEntries(file).find((e) => e.type === 'assistant' || e.type === 'user');
  if (!last) return age < 15000 ? 'working' : 'idle';
  const stop = last.type === 'assistant' ? last.message && last.message.stop_reason : 'pending';
  if (stop === 'end_turn' || stop === 'stop_sequence') return 'done';
  // A tool can run for minutes without writing to the log.
  if (stop === 'tool_use' || stop === 'pending') return age < 15 * 60 * 1000 ? 'working' : 'idle';
  return age < 60000 ? 'working' : 'done';
}

function readCodex(file, age) {
  const last = tailEntries(file)[0];
  const kind = last && last.payload && last.payload.type;
  if (kind === 'task_complete' || kind === 'turn_aborted') return 'done';
  return age < 5 * 60 * 1000 ? 'working' : 'idle';
}

const WAITING_MAX_MS = 30 * 60 * 1000;

// What Claude is waiting for, from a Notification or PreToolUse hook payload.
// "Waiting for your input" after a finished turn is not a question, so it is skipped:
// the finished state already covers it.
function askFrom(body) {
  const type = String(body.notification_type || '');
  const message = String(body.message || '');
  const tool = String(body.tool_name || '');
  if (tool === 'AskUserQuestion') {
    const q = body.tool_input && Array.isArray(body.tool_input.questions) && body.tool_input.questions[0];
    return { ask: 'question', detail: q && q.question ? String(q.question) : '' };
  }
  if (tool === 'ExitPlanMode') return { ask: 'plan', detail: '' };
  if (type === 'idle_prompt' || type === 'auth_success' || /waiting for your input/i.test(message)) return null;
  if (type === 'permission_prompt' || /permission/i.test(message)) {
    const m = /permission to use (.+)$/i.exec(message);
    return { ask: 'permission', detail: m ? m[1].trim() : '' };
  }
  if (type === 'elicitation_dialog') return { ask: 'question', detail: message };
  return message ? { ask: 'attention', detail: message } : null;
}

function createAgentWatcher(onChange) {
  let agent = 'off';
  let current = { agent, status: 'off', since: Date.now() };
  let log = null;
  let lastScan = 0;
  let hookStatus = 'idle';
  // Set by Claude Code hooks: Claude stopped and needs the person (a permission,
  // a question, a plan to approve). The session log can't tell this apart from work.
  let waiting = null; // { at, ask, detail, project }

  const set = (status, extra = {}) => {
    const same = status === current.status && agent === current.agent && extra.ask === current.ask && extra.detail === current.detail;
    if (same) return;
    const prev = current;
    current = { agent, status, since: status === prev.status && agent === prev.agent ? prev.since : Date.now(), ...extra };
    onChange(current, prev);
  };

  const tick = () => {
    if (agent === 'off') return set('off');
    if (agent === 'cursor') return set(hookStatus);
    const src = SOURCES[agent];
    const now = Date.now();
    if (!log || now - lastScan > 15000) { log = newestLog(src.dir, src.depth); lastScan = now; }
    if (!log) return set('idle');
    let mtime;
    try { mtime = fs.statSync(log.file).mtimeMs; } catch { log = null; return; }
    if (agent === 'claude' && waiting) {
      // Claude wrote to its log after asking: it moved on (an answer or a refusal)
      if (mtime > waiting.at + 4000 || now - waiting.at > WAITING_MAX_MS) waiting = null;
      else return set('waiting', { ask: waiting.ask, detail: waiting.detail, project: waiting.project });
    }
    const age = now - mtime;
    let status;
    try { status = agent === 'claude' ? readClaude(log.file, age) : readCodex(log.file, age); } catch { return; }
    if (status === 'done' && age > DONE_VISIBLE_MS) status = 'idle';
    set(status);
  };

  function onClaudeHook(event, body) {
    if (event === 'working' || event === 'done') { waiting = null; lastScan = 0; return tick(); }
    const ask = askFrom(body);
    if (!ask) return;
    waiting = { at: Date.now(), ...ask, project: body.cwd ? path.basename(String(body.cwd)) : '' };
    lastScan = 0;
    tick();
  }

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const cursor = /^\/agent\/cursor\/(working|done|idle)\b/.exec(url);
    const claude = /^\/agent\/claude\/(waiting|working|done)\b/.exec(url);
    if (cursor) { hookStatus = cursor[1]; tick(); }
    if (!claude) return res.writeHead(cursor ? 204 : 404).end();
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { if (raw.length < 64 * 1024) raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      onClaudeHook(claude[1], body);
      res.writeHead(204).end();
    });
  });
  server.on('error', () => {});
  server.listen(HOOK_PORT, '127.0.0.1');

  const timer = setInterval(tick, 1500);
  return {
    setAgent(name) { agent = name; log = null; hookStatus = 'idle'; waiting = null; tick(); },
    get: () => current,
    stop() { clearInterval(timer); server.close(); },
  };
}

const CURSOR_HOOKS = JSON.stringify({
  version: 1,
  hooks: {
    beforeSubmitPrompt: [{ command: `curl -s http://127.0.0.1:${HOOK_PORT}/agent/cursor/working` }],
    stop: [{ command: `curl -s http://127.0.0.1:${HOOK_PORT}/agent/cursor/done` }],
  },
}, null, 2);

// What the island needs in ~/.claude/settings.json. Each hook hands its JSON to
// the island in the background and stays silent when the island isn't running.
const claudeHook = (event) => ({
  type: 'command',
  command: `curl -s -m 2 -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${HOOK_PORT}/agent/claude/${event} >/dev/null 2>&1 || true`,
  async: true,
});
const CLAUDE_HOOKS = {
  Notification: [{ matcher: '', hooks: [claudeHook('waiting')] }],
  PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [claudeHook('waiting')] }],
  PostToolUse: [{ matcher: '', hooks: [claudeHook('working')] }],
  UserPromptSubmit: [{ hooks: [claudeHook('working')] }],
  Stop: [{ hooks: [claudeHook('done')] }],
};

module.exports = { createAgentWatcher, CURSOR_HOOKS, CLAUDE_HOOKS, askFrom };
