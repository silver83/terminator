# Terminator

**Playwright for terminals** — an MCP server that lets AI agents interact with CLI applications.

Terminator wraps [tmux](https://github.com/tmux/tmux) to give AI agents the ability to spawn CLI processes, type into them, read what's on screen, and assert on the output. It's like Playwright, but for terminal applications instead of web browsers.

## Why

Testing CLI applications today means either:
- A human manually runs commands and eyeballs the output
- Fragile `expect`-style scripts that match on raw byte streams

Terminator gives you a virtual terminal with a proper PTY, ANSI rendering, and a screen buffer — exactly what a human sees. An AI agent (or any test script) can spawn a process, interact with it, take "screenshots" of the rendered terminal, and assert on the visible output.

## Prerequisites

- **Node.js** >= 20
- **tmux** >= 3.0 (`brew install tmux` on macOS, `apt install tmux` on Linux)

## Installation

```bash
npm install -g terminator-mcp
```

Or clone and build from source:

```bash
git clone https://github.com/silver83/terminator.git
cd terminator
npm install
npm run build
```

## Usage with Claude Code

Add to your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "terminator": {
      "command": "node",
      "args": ["/path/to/terminator/build/index.js"]
    }
  }
}
```

Then Claude can use the terminal tools directly:

> "Spawn a bash session, run `ls -la`, and tell me what files are in the directory"

## Tools

| Tool | Description |
|------|-------------|
| `terminal_spawn` | Start a CLI process in a virtual terminal |
| `terminal_type` | Type text into the terminal |
| `terminal_send_key` | Send special keys (Enter, Escape, Ctrl-C, Tab, arrows, etc.) |
| `terminal_screenshot` | Capture what the user currently sees (rendered text) |
| `terminal_wait_for` | Poll until a regex pattern appears on screen |
| `terminal_assert` | Assert screen contains expected text or pattern |
| `terminal_close` | Close the terminal session |

## Example: Testing a CLI application

```
# 1. Spawn the application
terminal_spawn(command: "python3")

# 2. Wait for the REPL to load
terminal_wait_for(pattern: ">>>")

# 3. Type a command
terminal_type(text: "print('hello world')")
terminal_send_key(key: "enter")

# 4. Wait for output and verify
terminal_wait_for(pattern: "hello world")
terminal_assert(text: "hello world")

# 5. Clean up
terminal_send_key(key: "ctrl-d")
terminal_close()
```

## Example: Testing an interactive prompt

```
# Spawn an app that shows an interactive prompt
terminal_spawn(command: "my-cli-tool")

# Wait for the prompt to render
terminal_wait_for(pattern: "Are you sure\\?")

# Take a screenshot to see the full UI
terminal_screenshot()

# Type a response
terminal_type(text: "y")
terminal_send_key(key: "enter")

# Verify the result
terminal_wait_for(pattern: "Done!")
terminal_assert(text: "Done!")
```

## How it works

Terminator is a thin MCP server that delegates to tmux:

- **Spawn** = `tmux new-session -d -s <id> -x <cols> -y <rows> <command>`
- **Type** = `tmux send-keys -t <id> -l <text>` (literal characters)
- **Send key** = `tmux send-keys -t <id> <key>` (interpreted key names)
- **Screenshot** = `tmux capture-pane -t <id> -p` (rendered text, ANSI stripped)
- **Wait for** = polling loop over `capture-pane` until regex matches
- **Assert** = `capture-pane` + string/regex match
- **Close** = `tmux kill-session -t <id>`

tmux handles all the hard parts: PTY allocation, ANSI escape sequence parsing, screen buffer management, and terminal rendering. Terminator just exposes it as MCP tools.

## Running tests

```bash
npm run build
npm test
```

## License

MIT
