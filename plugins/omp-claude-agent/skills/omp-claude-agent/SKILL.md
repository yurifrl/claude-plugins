---
name: omp-claude-agent
description: Open an omp (oh-my-pi) agent session in a Tern pane showing the real omp TUI, prompt it, and be woken when it finishes a turn. This skill should be used whenever the user asks to open, start, spawn or launch an omp session, a "tern omp session", or an omp pane/split/tab, or to say something to, ask, delegate to, or drive omp. Triggers on "open omp", "omp session", "tern omp", "talk to omp", "ask omp".
---

# omp-claude-agent

Use the plugin's tools, never a hand-launched `omp` or `tern send`:

| Tool | Use |
|------|-----|
| `mcp__omp-claude-agent__open` | Start omp in a Tern pane (split right by default) and wait until it is ready |
| `mcp__omp-claude-agent__send` | Prompt it and get the final reply; `mode` `steer` / `follow_up` while a turn runs |
| `mcp__omp-claude-agent__state` | Session id and file, model, idle or waiting on the user, last reply |
| `mcp__omp-claude-agent__list` | Live sessions and which ones this Claude session opened |
| `mcp__omp-claude-agent__abort` | Stop the running turn |
| `mcp__omp-claude-agent__close` | Shut omp down and close its pane |

`state`, `list`, `abort` and `close` sit behind ToolSearch.

## How it behaves

- **Placement.** `open` splits the pane Claude runs in, omp on the right. Leave `place` unset unless the user asks for something else: `down` for a split below, `tab` for a new tab.
- The pane is the normal interactive omp. The user can type in it, and tool approvals and `ask` questions appear there for the user to answer. Do not answer them for the user.
- **Wake-ups.** Once a session is open, a prompt arrives here by itself whenever a turn in it finishes and no `send` is waiting for it: a turn the user started in the pane, a `send` with `wait: false`, or a `send` whose wait timed out. Never poll, sleep or re-send to check on a turn.
- `send` waits 300 s by default. A timeout is not a failure; the reply comes later as a wake-up.
- Messages are delivered verbatim; slash commands in the text are not expanded.
- Leave the session open when the user asked to see it. Close only sessions opened for a finished side task.

## Troubleshooting

- `open` reports omp did not become ready: read the pane with `tern capture <block> --surfaces`; the omp error is there.
- "no live omp session": omp exited or the user closed the pane. Open it again.
- Startup warnings in the pane (Ollama discovery, an extension failing to load) do not stop the session.
- The bridge is `extension/omp-claude-agent.ts`, loaded only into sessions this plugin opens (`omp -e`). It serves HTTP on `~/.cache/omp-claude-agent/<name>/sock`; add a route there and a tool in `hooks/register.ts` for any new control.
