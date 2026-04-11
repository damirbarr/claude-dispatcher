// Runs the sessions module against a temp state dir. No external services.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Override STATE_DIR by loading the module with a hijacked HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-sessions-'));
process.env.HOME = tmpHome;

// Must be required AFTER HOME is set so path.join(os.homedir(), ...) picks it up
const store = require('../src/sessions');

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok: ${msg}`);
}

try {
  console.log('test-sessions: starting');
  console.log(`  state dir: ${store.STATE_DIR}`);
  assert(store.STATE_DIR.startsWith(tmpHome), 'STATE_DIR honors HOME override');

  // empty state
  let s = store.load();
  assert(s.counter === 0, 'fresh state counter=0');
  assert(Object.keys(s.sessions).length === 0, 'fresh state has no sessions');

  // nextName
  const n1 = store.nextName(s);
  const n2 = store.nextName(s);
  assert(n1 === 'agent-1', 'first name is agent-1');
  assert(n2 === 'agent-2', 'second name is agent-2');

  // add
  store.add(s, { name: n1, url: 'https://claude.ai/remote-control/abc', prompt: 'hi', createdAt: new Date().toISOString() });
  store.add(s, { name: n2, url: null, prompt: 'there', createdAt: new Date().toISOString() });
  assert(store.list(s).length === 2, 'list returns 2 sessions');

  // reload from disk
  const s2 = store.load();
  assert(s2.counter === 2, 'counter persisted');
  assert(Object.keys(s2.sessions).length === 2, 'sessions persisted');
  assert(s2.sessions['agent-1'].url === 'https://claude.ai/remote-control/abc', 'url persisted');

  // update
  store.update(s2, 'agent-2', { url: 'https://claude.ai/remote-control/xyz' });
  const s3 = store.load();
  assert(s3.sessions['agent-2'].url === 'https://claude.ai/remote-control/xyz', 'update persisted');

  // remove
  store.remove(s3, 'agent-1');
  const s4 = store.load();
  assert(!s4.sessions['agent-1'], 'agent-1 removed');
  assert(s4.sessions['agent-2'], 'agent-2 still present');

  // corrupt file recovery
  fs.writeFileSync(store.STATE_FILE, 'not json');
  const s5 = store.load();
  assert(s5.counter === 0 && Object.keys(s5.sessions).length === 0, 'corrupt file -> fresh state');

  console.log('test-sessions: all ok');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
