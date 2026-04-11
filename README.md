# claude-dispatcher

Telegram bot that spawns Claude Code sessions in tmux and sends back remote-control URLs. Dispatch coding agents from your phone.

## What it does

- Send any message to the bot = spawn a new Claude Code agent in a tmux window
- Agent runs in **yolo mode** (`--dangerously-skip-permissions`) from a configurable working directory
- Bot captures the `/remote-control` URL and replies with a clickable link
- Each agent lives in its own tmux window inside session `claude-dispatch`

### Commands

| Command | Description |
|---|---|
| _(any text)_ | Spawn a new agent with that text as the prompt |
| `/list` | All sessions with clickable URLs, prompts, and age |
| `/branch agent-N` | Re-run `/remote-control` on an existing agent, get a new link |
| `/kill agent-N` | Kill that tmux window |
| `/killall` | Kill all agents |
| `/peek agent-N` | Last 15 lines of that agent's output |
| `/status` | Bot uptime, session count, config |

## Prerequisites

- Node.js 18+
- `tmux`
- `claude` CLI installed and on PATH (or set `CLAUDE_BIN` to full path)

## 1. Create the Telegram bot

1. Open Telegram, message **@BotFather**
2. Send `/newbot`, pick a name
3. Copy the token it gives you (looks like `123456789:ABC...`)

That's the only token you need.

## 2. Get your chat ID

Message **@userinfobot** in Telegram. It replies with your user ID. That's your `TELEGRAM_CHAT_ID`. This restricts the bot to only respond to you.

## 3. Configure

```bash
mkdir -p ~/.claude-sessions
cp .env.example ~/.claude-sessions/.env
nano ~/.claude-sessions/.env     # paste your two values
chmod 600 ~/.claude-sessions/.env
```

## 4. Install and test

```bash
cd ~/claude-dispatcher   # or wherever you cloned this
npm install
npm test                 # unit tests (no tokens needed)
node src/index.js --dry-run
node src/index.js        # foreground, ctrl-c to stop
```

Message the bot in Telegram. You should see a reply within ~15s.

## 5. Run as a systemd user service

```bash
# Edit the ExecStart path in the unit file if your node/claude paths differ
cp claude-dispatcher.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-dispatcher
journalctl --user -u claude-dispatcher -f
```

Survive logout:

```bash
sudo loginctl enable-linger $USER
```

## Configuration

All config lives in `~/.claude-sessions/.env`:

```bash
# Required
TELEGRAM_BOT_TOKEN=123456789:ABC...
TELEGRAM_CHAT_ID=your_user_id

# Optional
CLAUDE_BIN=/home/you/.local/bin/claude
AGENT_CWD=/home/you/workspace
URL_TIMEOUT_MS=45000
READY_TIMEOUT_MS=15000
```

## Layout

```
claude-dispatcher/
  src/
    index.js       # Telegram bot + agent spawning
    tmux.js        # tmux CLI wrapper
    sessions.js    # JSON state persistence
  scripts/
    test-sessions.js
    test-tmux.js
  .env.example
  claude-dispatcher.service   # systemd unit
  README.md

~/.claude-sessions/           # runtime state (not in repo)
  .env                        # tokens
  sessions.json               # auto-generated
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot doesn't respond | Wrong `TELEGRAM_CHAT_ID`, or bot not started. Check `journalctl --user -u claude-dispatcher -f` |
| "no URL captured" | Claude TUI took too long. Bump `URL_TIMEOUT_MS` or `/peek` the agent |
| `node: not found` in systemd | Edit `ExecStart` in the service file to use the absolute node path (`which node`) |
| Stale sessions in `/list` | `/killall` cleans everything, or manually `tmux kill-session -t claude-dispatch` |
