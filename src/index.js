const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const ENV_PATH = path.join(os.homedir(), '.claude-sessions', '.env');
require('dotenv').config({ path: ENV_PATH, override: true });

const { Telegraf } = require('telegraf');
const tmux = require('./tmux');
const store = require('./sessions');

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  CLAUDE_BIN = 'claude',
  AGENT_CWD = os.homedir() + '/workspace',
  URL_TIMEOUT_MS = '120000',
  READY_TIMEOUT_MS = '30000',
} = process.env;

const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN) {
  const missing = [];
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    console.error('Missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

const ALLOWED_CHATS = new Set(
  (TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean)
);

const RC_URL_RE = /https:\/\/claude\.ai\/code\/session_[a-zA-Z0-9_-]+/;
const READY_MARKERS = ['\u2502 >', '\u256d', 'Claude', 'claude.ai/code'];
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const state = store.load();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stripAnsi = s => s.replace(ANSI_RE, '');

function safeCapture(name) {
  try { return stripAnsi(tmux.capturePane(name)); }
  catch { return null; }
}

async function waitForReady(name, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(300);
    const p = safeCapture(name);
    if (p && READY_MARKERS.some(m => p.includes(m))) return true;
  }
  return false;
}

// Derive the claude project slug from the CWD (matches Claude Code's own mapping)
function projectDirPath(cwd) {
  const slug = (cwd || AGENT_CWD).replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function bridgePointerPath(cwd) {
  return path.join(projectDirPath(cwd), 'bridge-pointer.json');
}

function readBridgePointer(bpPath) {
  try {
    const stat = fs.statSync(bpPath);
    const data = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
    const sessionId = data.sessionId || null;
    return {
      sessionId,
      url: data.url || (sessionId ? 'https://claude.ai/code/' + sessionId : null),
      mtimeMs: stat.mtimeMs,
    };
  } catch { return null; }
}

function readBridgeSessionId(bpPath) {
  const pointer = readBridgePointer(bpPath);
  return pointer && pointer.sessionId;
}

function buildSessionUrl(sessionId) {
  if (!sessionId) return null;
  return 'https://claude.ai/code/' + sessionId;
}

function runtimeSessionsDir() {
  return path.join(os.homedir(), '.claude', 'sessions');
}

function readRuntimeSessionRecords() {
  try {
    return fs.readdirSync(runtimeSessionsDir())
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const file = path.join(runtimeSessionsDir(), name);
        try {
          return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findRuntimeSessionBySessionId(sessionId) {
  return readRuntimeSessionRecords().find(record => record.sessionId === sessionId) || null;
}

async function waitForRuntimeBridgeSession(sessionId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const record = findRuntimeSessionBySessionId(sessionId);
    if (record && record.bridgeSessionId) {
      return {
        sessionId,
        url: buildSessionUrl(record.bridgeSessionId),
        bridgeSessionId: record.bridgeSessionId,
        source: 'runtime-session',
      };
    }
    await sleep(300);
  }
  return null;
}

function snapshotProjectSessions(cwd) {
  const projectDir = projectDirPath(cwd);
  try {
    const out = {};
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, entry.name);
      const stat = fs.statSync(fullPath);
      out[entry.name] = stat.mtimeMs;
    }
    return out;
  } catch {
    return {};
  }
}

function readProjectSession(projectFile) {
  try {
    const stat = fs.statSync(projectFile);
    const sessionId = path.basename(projectFile, '.jsonl');
    return {
      sessionId,
      url: buildSessionUrl(sessionId),
      mtimeMs: stat.mtimeMs,
      source: 'project-jsonl',
    };
  } catch {
    return null;
  }
}

function newestProjectSessionSince(cwd, baselineFiles) {
  const projectDir = projectDirPath(cwd);
  try {
    let best = null;
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, entry.name);
      const stat = fs.statSync(fullPath);
      const baselineMtimeMs = baselineFiles && baselineFiles[entry.name] ? baselineFiles[entry.name] : 0;
      if (stat.mtimeMs <= baselineMtimeMs) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = {
          sessionId: path.basename(entry.name, '.jsonl'),
          url: buildSessionUrl(path.basename(entry.name, '.jsonl')),
          mtimeMs: stat.mtimeMs,
          source: 'project-jsonl',
        };
      }
    }
    return best;
  } catch {
    return null;
  }
}

function readJsonlTailLines(projectFile, maxLines = 80) {
  try {
    const text = fs.readFileSync(projectFile, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').slice(-maxLines);
  } catch {
    return [];
  }
}

function readRemoteBridgeFromProjectFile(projectFile) {
  const lines = readJsonlTailLines(projectFile);
  let bridgeSessionId = null;
  let sessionId = path.basename(projectFile, '.jsonl');
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'bridge-session' && obj.bridgeSessionId) {
        bridgeSessionId = obj.bridgeSessionId;
      }
      if (obj.sessionId) {
        sessionId = obj.sessionId;
      }
    } catch {}
  }
  if (!bridgeSessionId) return null;
  return {
    sessionId,
    url: buildSessionUrl(sessionId),
    bridgeSessionId,
    source: 'project-jsonl',
  };
}

// Poll bridge-pointer.json for a fresh write or a changed sessionId.
// Falls back to pane scraping so old agents without RC still work.
async function waitForUrl(name, ms, baselinePointer, baselineProjectFiles) {
  const bpPath = bridgePointerPath(AGENT_CWD);
  const baselineMtimeMs = baselinePointer && baselinePointer.mtimeMs ? baselinePointer.mtimeMs : 0;
  const baselineSessionId = baselinePointer && baselinePointer.sessionId ? baselinePointer.sessionId : null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    // Primary: bridge-pointer.json written by /remote-control
    const pointer = readBridgePointer(bpPath);
    if (pointer && pointer.url && (
      pointer.mtimeMs > baselineMtimeMs ||
      (pointer.sessionId && pointer.sessionId !== baselineSessionId)
    )) {
      return { url: pointer.url, sessionId: pointer.sessionId || null, source: 'bridge-pointer' };
    }
    // Secondary: Claude project transcript file. Newer Claude versions keep the
    // bridge session here even when bridge-pointer.json is absent.
    const projectSession = newestProjectSessionSince(AGENT_CWD, baselineProjectFiles);
    if (projectSession) {
      const remote = readRemoteBridgeFromProjectFile(
        path.join(projectDirPath(AGENT_CWD), projectSession.sessionId + '.jsonl')
      );
      if (remote && remote.url) {
        return remote;
      }
    }
    // Fallback: pane scrape (works for older Claude versions)
    const p = safeCapture(name);
    if (p) {
      const m = p.match(RC_URL_RE);
      if (m) return { url: m[0], sessionId: null, source: 'pane-scrape' };
    }
    await sleep(500);
  }
  return null;
}

async function waitForRemoteControlActive(name, sessionId, ms) {
  const t0 = Date.now();
  const projectFile = sessionId
    ? path.join(projectDirPath(AGENT_CWD), sessionId + '.jsonl')
    : null;
  while (Date.now() - t0 < ms) {
    const pane = safeCapture(name);
    if (pane && pane.includes('Remote Control active')) return true;
    if (projectFile) {
      const remote = readRemoteBridgeFromProjectFile(projectFile);
      if (remote && remote.bridgeSessionId) return true;
    }
    await sleep(300);
  }
  return false;
}

async function waitForUserPromptCommitted(sessionId, prompt, ms) {
  if (!prompt) return true;
  const projectFile = path.join(projectDirPath(AGENT_CWD), sessionId + '.jsonl');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const lines = fs.readFileSync(projectFile, 'utf8').trim().split('\n').slice(-40);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const content = obj && obj.message && obj.message.content;
          if (obj.type === 'user' && typeof content === 'string' && content === prompt) {
            return true;
          }
        } catch {}
      }
    } catch {}
    await sleep(300);
  }
  return false;
}

// Wait for a NEW url (different from oldUrl) to appear
async function waitForNewUrl(name, oldUrl, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = safeCapture(name);
    if (p) {
      // Find ALL urls, pick one that differs from oldUrl
      const matches = p.match(new RegExp(RC_URL_RE.source, 'g')) || [];
      const fresh = matches.find(u => u !== oldUrl);
      if (fresh) return fresh;
    }
    await sleep(500);
  }
  return null;
}

async function spawnAgent(prompt, reply) {
  const name = store.nextName(state);
  const sessionId = crypto.randomUUID();
  store.save(state);
  console.log('[dispatch] spawn', name, 'session=' + sessionId);

  tmux.ensureSession();
  tmux.newWindow(name, {
    cwd: AGENT_CWD,
    command: CLAUDE_BIN + ' --dangerously-skip-permissions --session-id ' + sessionId,
  });

  await waitForReady(name, +READY_TIMEOUT_MS);

  const oneLinePrompt = prompt.replace(/\r?\n/g, ' ').trim();
  if (oneLinePrompt) {
    await sleep(400);
    tmux.sendText(name, oneLinePrompt);
    tmux.sendEnter(name);
  }

  await waitForUserPromptCommitted(sessionId, oneLinePrompt, 15000);
  const remote = await waitForRuntimeBridgeSession(sessionId, +URL_TIMEOUT_MS);
  const url = remote && remote.url ? remote.url : null;

  store.add(state, {
    name, url, sessionId, prompt: prompt.slice(0, 2000), createdAt: new Date().toISOString(),
    parentAgent: null,
  });

  if (url) {
    await reply('<b>' + name + '</b> ready\n' + url);
  } else {
    await reply('<b>' + name + '</b> spawned, waiting for Remote Control URL…\n<code>tmux attach -t ' + tmux.SESSION + '</code>');
    // Keep polling in background — heavy load can delay URL by 2-5 min
    pollUrlBackground(name, reply, 10 * 60 * 1000, null, null);
  }
  return name;
}

// Polls a pane for a URL up to `maxMs` after initial timeout failed.
// Sends a follow-up Telegram message when found.
async function pollUrlBackground(name, reply, maxMs, baselinePointer, baselineProjectFiles) {
  var existing = state.sessions[name] && state.sessions[name].url;
  if (existing) return; // already captured
  var bpPath = bridgePointerPath(AGENT_CWD);
  var baselineMtimeMs = baselinePointer && baselinePointer.mtimeMs ? baselinePointer.mtimeMs : 0;
  var baselineSessionId = baselinePointer && baselinePointer.sessionId ? baselinePointer.sessionId : null;
  var trackedSessionId = state.sessions[name] && state.sessions[name].sessionId ? state.sessions[name].sessionId : null;
  var t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(5000);
    if (!tmux.windowExists(name)) break; // window gone
    if (trackedSessionId) {
      var runtimeRemote = await waitForRuntimeBridgeSession(trackedSessionId, 1000);
      if (runtimeRemote && runtimeRemote.url) {
        store.update(state, name, { url: runtimeRemote.url, sessionId: trackedSessionId });
        try { await reply('<b>' + name + '</b> URL found (late):\n' + runtimeRemote.url); } catch (e) {}
        return;
      }
    }
    // Primary: bridge-pointer.json
    var pointer = readBridgePointer(bpPath);
    if (pointer && pointer.url && (
      pointer.mtimeMs > baselineMtimeMs ||
      (pointer.sessionId && pointer.sessionId !== baselineSessionId)
    )) {
      var found = pointer.url;
      store.update(state, name, { url: found, sessionId: pointer.sessionId || null });
      try { await reply('<b>' + name + '</b> URL found (late):\n' + found); } catch (e) {}
      return;
    }
    var projectSession = newestProjectSessionSince(AGENT_CWD, baselineProjectFiles);
    if (projectSession && projectSession.url) {
      store.update(state, name, { url: projectSession.url, sessionId: projectSession.sessionId || null });
      try { await reply('<b>' + name + '</b> URL found (late):\n' + projectSession.url); } catch (e) {}
      return;
    }
    // Fallback: pane scrape
    var p = safeCapture(name);
    if (p) {
      var m = p.match(RC_URL_RE);
      if (m) {
        store.update(state, name, { url: m[0] });
        try { await reply('<b>' + name + '</b> URL found (late):\n' + m[0]); } catch (e) {}
        return;
      }
    }
  }
}

// Branch = fork a claude session: full conversation history, new session ID
async function branchAgent(parentName, reply) {
  var parent = store.get(state, parentName);
  if (!parent) return reply('No session <code>' + parentName + '</code>.');

  // Newer Claude versions use UUID-like session ids in project .jsonl files.
  // Older ones were stored in the URL as session_xxx.
  var sessionId = parent.sessionId || null;
  if (!sessionId && parent.url) {
    var suffix = parent.url.split('/code/')[1];
    if (suffix) sessionId = suffix;
  }

  if (!sessionId) {
    return reply('No session ID stored for <code>' + parentName + '</code>. Cannot fork.');
  }

  var childName = store.nextName(state);
  store.save(state);
  console.log('[dispatch] fork', childName, 'from', parentName, 'session=' + sessionId);


  tmux.ensureSession();
  // --resume <id> loads the full conversation, --fork-session gives it a new ID
  var baselineProjectFiles = snapshotProjectSessions(AGENT_CWD);
  tmux.newWindow(childName, {
    cwd: AGENT_CWD,
    command: CLAUDE_BIN + ' --dangerously-skip-permissions --resume ' + sessionId + ' --fork-session',
  });

  await waitForReady(childName, +READY_TIMEOUT_MS);

  var baselinePointer = readBridgePointer(bridgePointerPath(AGENT_CWD));
  tmux.sendText(childName, '/remote-control');
  tmux.sendEnter(childName);

  var remote = await waitForUrl(childName, +URL_TIMEOUT_MS, baselinePointer, baselineProjectFiles);
  var url = remote && remote.url ? remote.url : null;
  var childSessionId = remote && remote.sessionId ? remote.sessionId : null;

  store.add(state, {
    name: childName,
    url: url,
    sessionId: childSessionId,
    prompt: '(forked from ' + parentName + ') ' + (parent.prompt || '').slice(0, 1500),
    createdAt: new Date().toISOString(),
    parentAgent: parentName,
  });


  if (url) {
    await reply('<b>' + childName + '</b> (forked from ' + parentName + ')\n' + url);
  } else {
    await reply('<b>' + childName + '</b> forked, no URL.\n<code>tmux attach -t ' + tmux.SESSION + '</code>');
  }
}

function listSessions() {
  var all = store.list(state);
  if (!all.length) return 'No active sessions.';
  var wins = new Set(tmux.listWindows());
  return all.map(function(s) {
    var alive = wins.has(s.name);
    var status = alive ? '' : ' [gone]';
    var age = timeSince(s.createdAt);
    var promptPreview = s.prompt ? s.prompt.slice(0, 60).replace(/</g, '&lt;') : '';
    var parent = s.parentAgent ? ' (from ' + s.parentAgent + ')' : '';
    var derivedUrl = s.url || buildSessionUrl(s.sessionId);
    var urlLine = derivedUrl ? '\n  ' + derivedUrl : '\n  <i>no URL</i>';
    return '<b>' + s.name + '</b> (' + age + ')' + parent + status
      + '\n  <i>' + promptPreview + (s.prompt && s.prompt.length > 60 ? '...' : '') + '</i>'
      + urlLine;
  }).join('\n\n');
}

function timeSince(iso) {
  var ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
  return Math.floor(ms / 86400000) + 'd';
}

function killSession(name) {
  if (!state.sessions[name]) return 'No session <code>' + name + '</code>.';
  tmux.killWindow(name);
  store.remove(state, name);
  return 'Killed <b>' + name + '</b>.';
}

function killAll() {
  var all = store.list(state);
  if (!all.length) return 'No sessions to kill.';
  var count = 0;
  for (var i = 0; i < all.length; i++) {
    tmux.killWindow(all[i].name);
    store.remove(state, all[i].name);
    count++;
  }
  return 'Killed <b>' + count + '</b> session(s).';
}

function peekSession(name) {
  if (!state.sessions[name]) return 'No session <code>' + name + '</code>.';
  var p = safeCapture(name);
  if (!p) return '<code>' + name + '</code> tmux window not found.';
  // Filter out TUI chrome: box-drawing, status bars, empty lines, prompts
  var lines = p.split('\n').filter(function(l) {
    var t = l.trim();
    if (!t) return false;
    // Skip box-drawing lines (TUI borders)
    if (/^[\u2500-\u257f\u2580-\u259f\s|]+$/.test(t)) return false;
    // Skip Claude TUI chrome
    if (t.match(/^[\u256d\u256e\u2570\u256f\u2502\u2500\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c\u2551\u2550]/)) return false;
    // Skip status bar items
    if (t.match(/bypass permissions|shift\+tab|Remote Control active/i)) return false;
    // Skip empty prompt lines
    if (t === '>' || t === '\u276f') return false;
    return true;
  }).slice(-20);
  if (!lines.length) return '<b>' + name + '</b>: no readable output.';
  // Truncate long lines
  lines = lines.map(function(l) { return l.length > 200 ? l.slice(0, 200) + '...' : l; });
  return '<b>' + name + '</b>:\n<pre>' + escapeHtml(lines.join('\n')) + '</pre>';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var bot;

function buildBot() {
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.telegram.setMyCommands([
    { command: 'list', description: 'Show all sessions with links and prompts' },
    { command: 'url', description: 'Get/refresh URL for a session: /url agent-N' },
    { command: 'kill', description: 'Kill a session: /kill agent-N' },
    { command: 'killall', description: 'Kill ALL sessions' },
    { command: 'branch', description: 'Fork session with full history: /branch agent-N' },
    { command: 'peek', description: 'Last output: /peek agent-N' },
    { command: 'status', description: 'System status' },
    { command: 'help', description: 'Show commands' },
  ]).catch(function(e) { console.warn('setMyCommands failed:', e.message); });

  bot.use(function(ctx, next) {
    if (!ctx.chat) return;
    if (!ALLOWED_CHATS.has(String(ctx.chat.id))) return;
    return next();
  });

  bot.command('start', function(ctx) {
    return ctx.reply(
      'Claude Dispatcher\n\n'
      + 'Send any text to spawn a Claude Code agent (yolo mode).\n'
      + 'Agent CWD: <code>' + AGENT_CWD + '</code>\n\n'
      + '/list - sessions with clickable links\n'
      + '/branch agent-N - fork with full history\n'
      + '/kill agent-N | /killall\n'
      + '/peek agent-N - last output\n'
      + '/status - system info',
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', function(ctx) {
    return ctx.reply(
      'Send any text = spawn new agent\n\n'
      + '/list - all sessions + links + prompts\n'
      + '/url [agent-N] - get or refresh remote control URL\n'
      + '/branch agent-N - fork with full history\n'
      + '/kill agent-N - kill one\n'
      + '/killall - kill all\n'
      + '/peek [agent-N] - last 15 lines (default: latest)\n'
      + '/status - uptime, tmux, config',
      { parse_mode: 'HTML' }
    );
  });

  bot.command('list', function(ctx) {
    return ctx.reply(listSessions(), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('kill', function(ctx) {
    var args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) return ctx.reply('Usage: /kill agent-N');
    return ctx.reply(killSession(args[0]), { parse_mode: 'HTML' });
  });

  bot.command('killall', function(ctx) {
    return ctx.reply(killAll(), { parse_mode: 'HTML' });
  });

  bot.command('url', async function(ctx) {
    var args = ctx.message.text.split(/\s+/).slice(1);
    var target;
    if (!args.length) {
      var all = store.list(state);
      if (!all.length) return ctx.reply('No sessions.');
      target = all[all.length - 1].name;
    } else {
      target = args[0];
    }
    if (!state.sessions[target]) return ctx.reply('No session <code>' + target + '</code>.', { parse_mode: 'HTML' });

    // Check bridge-pointer.json first (primary source since Claude Code stopped printing URL to terminal)
    var bp = readBridgePointer(bridgePointerPath(AGENT_CWD));
    if (bp && bp.url) {
      store.update(state, target, { url: bp.url, sessionId: bp.sessionId || state.sessions[target].sessionId || null });
      return ctx.reply('<b>' + target + '</b>\n' + bp.url, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    var projectSessionId = state.sessions[target] && state.sessions[target].sessionId;
    if (projectSessionId) {
      var runtimeRemote = findRuntimeSessionBySessionId(projectSessionId);
      if (runtimeRemote && runtimeRemote.bridgeSessionId) {
        var runtimeUrl = buildSessionUrl(runtimeRemote.bridgeSessionId);
        store.update(state, target, { url: runtimeUrl });
        return ctx.reply('<b>' + target + '</b>\n' + runtimeUrl, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
    }
    if (projectSessionId) {
      var derivedUrl = buildSessionUrl(projectSessionId);
      store.update(state, target, { url: derivedUrl });
      return ctx.reply('<b>' + target + '</b>\n' + derivedUrl, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    }
    // Fallback: pane scrape
    var p = safeCapture(target);
    if (p) {
      var m = p.match(RC_URL_RE);
      if (m) {
        store.update(state, target, { url: m[0] });
        return ctx.reply('<b>' + target + '</b>\n' + m[0], { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      }
    }
    // Fallback: stored URL
    var stored = state.sessions[target] && state.sessions[target].url;
    if (stored) return ctx.reply('<b>' + target + '</b>\n' + stored, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

    await ctx.reply('<b>' + target + '</b>: no URL found. Polling for up to 2 min…', { parse_mode: 'HTML' });
    var reply = function(msg) { return ctx.reply(msg, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); };
    pollUrlBackground(target, reply, 2 * 60 * 1000, null);
  });

  bot.command('branch', async function(ctx) {
    var args = ctx.message.text.split(/\s+/).slice(1);
    var target;
    if (!args.length) {
      var all = store.list(state);
      if (!all.length) return ctx.reply('No sessions.');
      target = all[all.length - 1].name;
    } else {
      target = args[0];
    }
    var reply = function(msg) {
      return ctx.reply(msg, { parse_mode: 'HTML' });
    };
    await reply('Forking <b>' + target + '</b>...');
    branchAgent(target, reply).catch(async function(e) {
      console.error('[branch]', e);
      try { await reply('Error: ' + escapeHtml(e.message)); } catch (e2) {}
    });
  });

  bot.command('peek', function(ctx) {
    var args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      var all = store.list(state);
      if (!all.length) return ctx.reply('No sessions.');
      return ctx.reply(peekSession(all[all.length - 1].name), { parse_mode: 'HTML' });
    }
    return ctx.reply(peekSession(args[0]), { parse_mode: 'HTML' });
  });

  bot.command('status', function(ctx) {
    var sessions = store.list(state);
    var wins = tmux.listWindows();
    var uptime = process.uptime();
    var h = Math.floor(uptime / 3600);
    var m = Math.floor((uptime % 3600) / 60);
    var lines = [
      '<b>Status</b>',
      'Bot uptime: ' + h + 'h ' + m + 'm',
      'Tracked sessions: ' + sessions.length,
      'Tmux windows: ' + wins.length + ' (' + wins.join(', ') + ')',
      'CWD: <code>' + AGENT_CWD + '</code>',
      'Claude: <code>' + CLAUDE_BIN + ' --dangerously-skip-permissions</code>',
    ];
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.on('text', async function(ctx) {
    var text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    var reply = function(msg) {
      return ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_parameters: { message_id: ctx.message.message_id },
      }).catch(function() {
        return ctx.reply(msg.replace(/<[^>]+>/g, ''), {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      });
    };

    try {
      await reply('Spawning: <i>' + escapeHtml(text.slice(0, 200)) + '</i>');
      spawnAgent(text, reply).catch(async function(e) {
        console.error('[spawn]', e);
        try { await reply('Error: ' + escapeHtml(e.message)); } catch (e2) {}
      });
    } catch (e) {
      console.error('[handler]', e);
      try { await reply('Error: ' + escapeHtml(e.message)); } catch (e2) {}
    }
  });

  bot.catch(function(e) { console.error('[telegraf]', e); });
}

async function main() {
  if (DRY_RUN) { console.log('dry-run OK'); return; }
  buildBot();
  await bot.launch();
  console.log('Claude dispatcher running (chats=' + [...ALLOWED_CHATS].join(',') + ')');
}

process.on('SIGINT', function() { if (bot) bot.stop('SIGINT'); process.exit(0); });
process.on('SIGTERM', function() { if (bot) bot.stop('SIGTERM'); process.exit(0); });
main().catch(function(e) { console.error('Fatal:', e); process.exit(1); });
