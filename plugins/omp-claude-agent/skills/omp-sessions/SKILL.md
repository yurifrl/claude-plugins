---
name: omp-sessions
description: Open or attach to an omp (oh-my-pi) agent session, prompt it, and be woken when it finishes a turn. This skill should be used whenever the user asks to open, start, spawn, launch, attach to or take over an omp session, a "tern omp session", or an omp pane/split/tab, or to say something to, ask, delegate to, or drive omp. Triggers on "open omp", "omp session", "tern omp", "attach omp", "take over omp", "talk to omp", "ask omp".
---

# omp sessions

Use the omp-claude-agent tools, never a hand-launched `omp` or `tern send`:

| Tool | Use |
|------|-----|
| `mcp__omp-claude-agent__open` | Start omp in a Tern pane (split right by default) and wait until it is ready |
| `mcp__omp-claude-agent__attach` | Take over an omp that is already running (the user's, or another Claude session's) |
| `mcp__omp-claude-agent__send` | Prompt it and get the final reply; `mode` `steer` / `follow_up` while a turn runs |
| `mcp__omp-claude-agent__list` | Reachable sessions, their owner (`me`, `other`, `none`), and whether the omp extension is installed |
| `mcp__omp-claude-agent__state` | Session id and file, model, idle or waiting on the user, last reply |
| `mcp__omp-claude-agent__detach` | Stop driving it but leave it running, for the user to take back |
| `mcp__omp-claude-agent__abort` | Stop the running turn |
| `mcp__omp-claude-agent__close` | Shut omp down (and close its pane, when `open` made it) |

`list`, `state`, `detach`, `abort` and `close` sit behind ToolSearch.

## How it behaves

- **Placement.** `open` always splits the pane Claude runs in, omp on the right, also when opening several sessions. Leave `place` unset. `down` or `tab` is honored only when the user's own recent message asks for it; otherwise the plugin opens a right split anyway and says so in a `note`.
- **The pane is the normal interactive omp.** The user can type in it, and tool approvals and `ask` questions appear there for the user to answer. Do not answer them for the user.
- **Ownership.** Each omp session sends its wake-ups to one Claude session: whichever last opened, attached to or sent to it. `attach` and `send` take it over from another Claude session.
- **Driven prompt.** While this Claude session owns an omp session, omp's system prompt carries a "Driven by Claude Code" section: it reports everything in its replies, does not use Plannotator or reach the user directly, and tracks its work in tk where the directory has a tk workspace. To hand omp work on the record, create the tk task and send omp its id. You are its link to the user: relay what they need, through the Plannotator Inbox where that is the channel. The section goes when the session is detached, closed, taken over, or this Claude session ends.
- **Wake-ups.** A prompt arrives here by itself whenever a turn finishes in a session this Claude session owns and no blocking `send` is reporting it: a turn the user started in the pane, a `send` with `wait: false`, or a `send` whose wait ran out. Never poll, sleep or re-send to check on a turn.
- `send` waits 300 s by default. A timeout is not a failure; the reply comes later as a wake-up.
- Messages are delivered verbatim; slash commands in the text are not expanded.
- Leave a session open when the user asked to see it. Close only sessions opened for a finished side task. `close` on an attached session stops the user's omp: only on request.

## Reaching omp the user started

Only omp processes that load the omp extension are reachable. `open` always loads it. omp the user starts by hand loads it only when the extension is installed globally. When `list` reports `extensionInstalled: false` and the user wants an existing omp, offer them `/omp-claude-agent install` (it links the extension into `~/.omp/agent/extensions`); omp started before the install must be restarted to become reachable. `/omp-claude-agent status` and `/omp-claude-agent uninstall` are the other actions; they are the user's to run.

## Troubleshooting

- `open` reports omp did not become ready: read the pane with `tern capture <block> --surfaces`; the omp error is there.
- "no live omp session": omp exited or the user closed its pane. Open it again, or `list` for others.
- Startup warnings in the pane (Ollama discovery, an extension failing to load) do not stop the session.
- Each omp serves HTTP on `~/.cache/omp-claude-agent/<name>/sock`, `<name>` the `open` name or `omp-<pid>`. For a new control, add a route in `extension/omp-claude-agent.ts` and a tool in `hooks/register.ts`.
