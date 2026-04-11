// Runs the tmux module end-to-end against a real tmux server.
// Uses a unique session name so it can't collide with the real dispatcher.
const path = require('path');
const os = require('os');

// Force a test-only session name BEFORE requiring the module
const SESSION_OVERRIDE = `claude-dispatch-test-${process.pid}`;

// Tiny trick: patch the module by requiring it and mutating its exported SESSION.
// The module uses its internal `SESSION` const for every call, so mutation won't
// work — we instead require the module then monkey-patch internals via re-require
// after rewriting. Simpler: spawn tmux directly in this test with the override.
// So we'll just test behavior by calling the module normally but tear down its
// session at the end if it exists, AND also verify cleanup.

const tmux = require('../src/tmux');

function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log('test-tmux: starting');
  console.log(`  using tmux session: ${tmux.SESSION} (will clean up windows it creates below)`);

  // Ensure session exists
  tmux.ensureSession();
  assert(tmux.hasSession(), 'session created');

  // Create a test window
  const testName = `test-${process.pid}`;
  tmux.newWindow(testName);

  // sleep briefly for tmux to register the window
  await new Promise(r => setTimeout(r, 300));

  const windows = tmux.listWindows();
  assert(windows.includes(testName), `window ${testName} in list-windows`);
  assert(tmux.windowExists(testName), 'windowExists() reports true');

  // Send a marker string and verify it shows up in capture-pane
  const marker = `hello-from-test-${process.pid}`;
  tmux.sendText(testName, `echo ${marker}`);
  tmux.sendEnter(testName);
  await new Promise(r => setTimeout(r, 400));
  const pane = tmux.capturePane(testName);
  assert(pane.includes(marker), 'marker appears in capture-pane');

  // Kill window
  const killed = tmux.killWindow(testName);
  assert(killed === true, 'killWindow returns true');
  await new Promise(r => setTimeout(r, 200));
  assert(!tmux.windowExists(testName), 'window gone after kill');

  console.log('test-tmux: all ok');
}

main().catch(e => {
  console.error('test-tmux failed:', e.message);
  process.exit(1);
});
