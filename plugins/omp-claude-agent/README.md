# omp-claude-agent

Lets Claude Code drive the real omp (oh-my-pi) TUI: open a session in a Tern pane or attach to one already running, send it prompts and get the replies, read its state, abort or close it. The Claude session that owns an omp session is prompted automatically whenever a turn there finishes unattended, including turns the user types in the omp pane.

One folder, both halves:

| Part | For | What it is |
|------|-----|------------|
| `.claude-plugin/plugin.json`, `hooks/` | Claude Code | Hooks module: the `mcp__omp-claude-agent__*` tools (`open`, `attach`, `send`, `list`, `state`, `detach`, `abort`, `close`), the wake-up watcher, and `/omp-claude-agent [status\|install\|uninstall]` |
| `skills/omp-sessions/` | Claude Code | When and how to use the tools |
| `package.json` (`omp.extensions`), `extension/` | omp | Extension that serves each omp process over HTTP on `~/.cache/omp-claude-agent/<name>/sock`; one copy runs per process even when loaded twice |

While a Claude session drives an omp session, the extension appends a "Driven by Claude Code" section to omp's system prompt each turn: omp reports in its replies and leaves Plannotator (the user's channel, which Claude keeps) alone. omp used by hand never gets it. Driving starts with `open`, `attach` or `send`, and ends with `detach`, `close`, another Claude session taking over, or the Claude session ending.

Requires `tern` and `omp` on `PATH`.

## Install

### Claude Code (declarative)

`~/.claude/settings.json`, with the marketplace this repo provides:

```jsonc
"extraKnownMarketplaces": {
  "yurifrl": { "source": { "source": "directory", "path": "/path/to/claude-plugins" } }
},
"enabledPlugins": { "omp-claude-agent@yurifrl": true }
```

Or from GitHub: `/plugin install omp-claude-agent --marketplace yurifrl/claude-plugins`.

That alone is enough for `open`: it starts omp with `omp -e <this folder>/extension/omp-claude-agent.ts`.

### omp (optional, for `attach` to omp you start yourself)

omp loads any folder in `~/.omp/agent/extensions/` whose `package.json` lists `omp.extensions`, so the install is one symlink to this folder:

```sh
ln -s /path/to/claude-plugins/plugins/omp-claude-agent ~/.omp/agent/extensions/omp-claude-agent
```

`/omp-claude-agent install` in Claude Code makes the same link (to the folder Claude loaded the plugin from) and `/omp-claude-agent uninstall` removes it. When `~/.omp/agent/extensions` is managed by a dotfiles repo, commit the link there and the install is declarative. omp has no settings key for plugins, so this link is the declarative route.

Every omp started after the install serves a socket; omp already running needs a restart. While installed, any Claude session on this machine can attach to and prompt your omp sessions. The sockets sit in a folder private to your user.
