const path = require('path');
const os = require('os');

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
  URL_TIMEOUT_MS = '45000',
  READY_TIMEOUT_MS = '15000',
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

async function waitForUrl(name, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = safeCapture(name);
    if (p) { const m = p.match(RC_URL_RE); if (m) return m[0]; }
    await sleep(500);
  }
  return null;
}

async function spawnAgent(prompt, reply) {
  const name = store.nextName(state);
  store.save(state);
  console.log('[dispatch] spawn', name);

  tmux.ensureSession();
  tmux.newWindow(name, {
    cwd: AGENT_CWD,
    command: CLAUDE_BIN + ' --dangerously-skip-permissions',
  });

  await waitForReady(name, +READY_TIMEOUT_MS);

  tmux.sendText(name, '/remote-control');
  tmux.sendEnter(name);

  const url = await waitForUrl(name, +URL_TIMEOUT_MS);

  const oneLinePrompt = prompt.replace(/\r?\n/g, ' ').trim();
  if (oneLinePrompt) {
    await sleep(400);
    tmux.sendText(name, oneLinePrompt);
    tmux.sendEnter(name);
  }

  store.add(state, {
    name, url, prompt: prompt.slice(0, 2000), createdAt: new Date().toISOString(),
  });

  if (url) {
    await reply('<b>' + name + '</b> ready\n' + url);
  } else {
    await reply('<b>' + name + '</b> spawned, no URL captured.\n<code>tmux attach -t ' + tmux.SESSION + '</code>');
  }
}

// Re-run /remote-control on an existing agent to get a fresh URL
async function branchAgent(name, reply) {
  const s = store.get(state, name);
  if (!s) return reply('No session <code>' + name + '</code>.');
  if (!tmux.windowExists(name)) return reply('<code>' + name + '</code> tmux window is gone.');

  await reply('Branching <b>' + name + '</b>...');

  tmux.sendText(name, '/remote-control');
  tmux.sendEnter(name);

  const url = await waitForUrl(name, +URL_TIMEOUT_MS);

  if (url) {
    store.update(state, name, { url });
    await reply('<b>' + name + '</b> new link:\n' + url);
  } else {
    await reply('<b>' + name + '</b> no URL captured. Try <code>/peek ' + name + '</code>.');
  }
}

function listSessions() {
  const all = store.list(state);
  if (!all.length) return 'No active sessions.';
  const wins = new Set(tmux.listWindows());
  return all.map(s => {
    const alive = wins.has(s.name);
    const status = alive ? '' : ' [gone]';
    const age = timeSince(s.createdAt);
    const promptPreview = s.prompt ? s.prompt.slice(0, 60).replace(/</g, '&lt;') : '';
    const urlLine = s.url ? '\n  ' + s.url : '\n  <i>no URL</i>';
    return '<b>' + s.name + '</b> (' + age + ')' + status
      + '\n  <i>' + promptPreview + (s.prompt && s.prompt.length > 60 ? '...' : '') + '</i>'
      + urlLine;
  }).join('\n\n');
}

function timeSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
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
  const all = store.list(state);
  if (!all.length) return 'No sessions to kill.';
  let count = 0;
  for (const s of all) {
    tmux.killWindow(s.name);
    store.remove(state, s.name);
    count++;
  }
  return 'Killed <b>' + count + '</b> session(s).';
}

function peekSession(name) {
  if (!state.sessions[name]) return 'No session <code>' + name + '</code>.';
  const p = safeCapture(name);
  if (!p) return '<code>' + name + '</code> tmux window not found.';
  const lines = p.split('\n').filter(l => l.trim()).slice(-15);
  return '<b>' + name + '</b> last output:\n<pre>' + escapeHtml(lines.join('\n')) + '</pre>';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let bot;

function buildBot() {
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.telegram.setMyCommands([
    { command: 'list', description: 'Show all sessions with links and prompts' },
    { command: 'kill', description: 'Kill a session: /kill agent-N' },
    { command: 'killall', description: 'Kill ALL sessions' },
    { command: 'branch', description: 'New remote-control link: /branch agent-N' },
    { command: 'peek', description: 'Last output: /peek agent-N' },
    { command: 'status', description: 'System status' },
    { command: 'help', description: 'Show commands' },
  ]).catch(e => console.warn('setMyCommands failed:', e.message));

  bot.use((ctx, next) => {
    if (!ctx.chat) return;
    if (!ALLOWED_CHATS.has(String(ctx.chat.id))) return;
    return next();
  });

  bot.command('start', ctx => ctx.reply(
    'Claude Dispatcher\n\n'
    + 'Send any text to spawn a Claude Code agent (yolo mode).\n'
    + 'Agent CWD: <code>' + AGENT_CWD + '</code>\n\n'
    + '/list - sessions with clickable links\n'
    + '/branch agent-N - get a new remote-control link\n'
    + '/kill agent-N | /killall\n'
    + '/peek agent-N - last output\n'
    + '/status - system info',
    { parse_mode: 'HTML' }
  ));

  bot.command('help', ctx => ctx.reply(
    'Send any text = spawn new agent\n\n'
    + '/list - all sessions + links + prompts\n'
    + '/branch agent-N - new remote-control link\n'
    + '/kill agent-N - kill one\n'
    + '/killall - kill all\n'
    + '/peek [agent-N] - last 15 lines (default: latest)\n'
    + '/status - uptime, tmux, config',
    { parse_mode: 'HTML' }
  ));

  bot.command('list', ctx => ctx.reply(listSessions(), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }));

  bot.command('kill', ctx => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) return ctx.reply('Usage: /kill agent-N');
    return ctx.reply(killSession(args[0]), { parse_mode: 'HTML' });
  });

  bot.command('killall', ctx => ctx.reply(killAll(), { parse_mode: 'HTML' }));

  bot.command('branch', async ctx => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      const all = store.list(state);
      if (!all.length) return ctx.reply('No sessions.');
      // Branch the most recent
      const latest = all[all.length - 1].name;
      return branchAgent(latest, msg => ctx.reply(msg, { parse_mode: 'HTML' }));
    }
    return branchAgent(args[0], msg => ctx.reply(msg, { parse_mode: 'HTML' }));
  });

  bot.command('peek', ctx => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    if (!args.length) {
      const all = store.list(state);
      if (!all.length) return ctx.reply('No sessions.');
      return ctx.reply(peekSession(all[all.length - 1].name), { parse_mode: 'HTML' });
    }
    return ctx.reply(peekSession(args[0]), { parse_mode: 'HTML' });
  });

  bot.command('status', async ctx => {
    const sessions = store.list(state);
    const wins = tmux.listWindows();
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const lines = [
      '<b>Status</b>',
      'Bot uptime: ' + h + 'h ' + m + 'm',
      'Tracked sessions: ' + sessions.length,
      'Tmux windows: ' + wins.length + ' (' + wins.join(', ') + ')',
      'CWD: <code>' + AGENT_CWD + '</code>',
      'Claude: <code>' + CLAUDE_BIN + ' --dangerously-skip-permissions</code>',
    ];
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.on('text', async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const reply = msg => ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_parameters: { message_id: ctx.message.message_id },
    }).catch(() => ctx.reply(msg.replace(/<[^>]+>/g, ''), {
      reply_parameters: { message_id: ctx.message.message_id },
    }));

    try {
      await reply('Spawning: <i>' + escapeHtml(text.slice(0, 200)) + '</i>');
      await spawnAgent(text, reply);
    } catch (e) {
      console.error('[handler]', e);
      try { await reply('Error: ' + escapeHtml(e.message)); } catch {}
    }
  });

  bot.catch(e => console.error('[telegraf]', e));
}

async function main() {
  if (DRY_RUN) { console.log('dry-run OK'); return; }
  buildBot();
  await bot.launch();
  console.log('Claude dispatcher running (chats=' + [...ALLOWED_CHATS].join(',') + ')');
}

process.on('SIGINT', () => { bot?.stop('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { bot?.stop('SIGTERM'); process.exit(0); });
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
