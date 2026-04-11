// Thin wrapper around tmux CLI. One session "claude-dispatch" with many windows.
const { execFileSync } = require('child_process');

const SESSION = 'claude-dispatch';

function run(args, opts = {}) {
  return execFileSync('tmux', args, { encoding: 'utf8', ...opts });
}

function runQuiet(args) {
  try {
    execFileSync('tmux', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function hasSession() {
  return runQuiet(['has-session', '-t', SESSION]);
}

function ensureSession() {
  if (!hasSession()) {
    // Start detached with a placeholder window that we never use as an agent
    runQuiet(['new-session', '-d', '-s', SESSION, '-n', 'control']);
  }
}

function newWindow(name, opts = {}) {
  ensureSession();
  const args = ['new-window', '-d', '-t', `${SESSION}:`, '-n', name];
  if (opts.cwd) args.push('-c', opts.cwd);
  if (opts.command) args.push(opts.command);
  runQuiet(args);
}

function windowExists(name) {
  return runQuiet(['has-session', '-t', `${SESSION}:${name}`]);
}

function sendText(name, text) {
  // -l sends literal text (no key name interpretation)
  run(['send-keys', '-t', `${SESSION}:${name}`, '-l', text], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function sendEnter(name) {
  run(['send-keys', '-t', `${SESSION}:${name}`, 'Enter'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function capturePane(name, lines = 500) {
  // -p = print to stdout; -J = join wrapped lines; -S -N = start N lines back
  return run(['capture-pane', '-p', '-t', `${SESSION}:${name}`, '-J', '-S', `-${lines}`]);
}

function killWindow(name) {
  return runQuiet(['kill-window', '-t', `${SESSION}:${name}`]);
}

function listWindows() {
  if (!hasSession()) return [];
  try {
    const out = run(['list-windows', '-t', SESSION, '-F', '#{window_name}']);
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  SESSION,
  hasSession,
  ensureSession,
  newWindow,
  windowExists,
  sendText,
  sendEnter,
  capturePane,
  killWindow,
  listWindows,
};
