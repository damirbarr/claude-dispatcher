// Persistent session state at ~/.claude-sessions/sessions.json
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude-sessions');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) {
    return { counter: 0, sessions: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // defensive defaults in case of partial writes
    parsed.counter = parsed.counter || 0;
    parsed.sessions = parsed.sessions || {};
    return parsed;
  } catch (e) {
    console.error('[sessions] corrupt state file, starting fresh:', e.message);
    return { counter: 0, sessions: {} };
  }
}

function save(state) {
  ensureDir();
  // atomic write via temp file + rename
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function nextName(state) {
  state.counter += 1;
  return `agent-${state.counter}`;
}

function add(state, session) {
  state.sessions[session.name] = session;
  save(state);
}

function update(state, name, patch) {
  if (!state.sessions[name]) return;
  state.sessions[name] = { ...state.sessions[name], ...patch };
  save(state);
}

function remove(state, name) {
  delete state.sessions[name];
  save(state);
}

function list(state) {
  return Object.values(state.sessions).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function get(state, name) {
  return state.sessions[name];
}

module.exports = {
  STATE_DIR,
  STATE_FILE,
  load,
  save,
  nextName,
  add,
  update,
  remove,
  list,
  get,
};
