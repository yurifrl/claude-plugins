# claude-plugins

Yuri's Claude Code plugins, written as TypeScript hooks modules ("mods").
One plugin per feature; this repo is also a plugin marketplace named `yurifrl`.
Most are ports of modules from [pi-yuri-extensions](https://github.com/yurifrl/pi-yuri-extensions).

| Plugin | What it does |
| --- | --- |
| `aws` | `/aws login [profiles...]` runs `aws sso login --no-browser` per profile and opens each SSO URL in that profile's Chrome profile; progress shows above the prompt |
| `session-id` | `session_id` tool (`mcp__session-id__session_id`) that returns the current session id |
| `respond` | `/respond` picks a past assistant message and loads it into the prompt; `/respond N` loads the Nth latest directly |

## Layout

```
.claude-plugin/marketplace.json   # lists every plugin by relative path
plugins/<name>/
  .claude-plugin/plugin.json      # manifest (+ userConfig options)
  hooks/hooks.json                # { "modules": ["./register.ts(x)"] }
  hooks/register.ts(x)            # export const register: Register = (on, options) => { ... }
  types/index.d.ts                # $.state contract, when the plugin keeps state
```

## Install (declarative, from dotfiles)

In `~/.claude/settings.json`:

```jsonc
"extraKnownMarketplaces": {
  "yurifrl": { "source": { "source": "directory", "path": "/Users/yuri/DotFiles/submodules/claude-plugins" } }
},
"enabledPlugins": { "aws@yurifrl": true, "session-id@yurifrl": true, "respond@yurifrl": true },
"pluginConfigs": {
  "aws@yurifrl": { "options": { "profiles": ["nsx"], "chromeProfiles": ["nsx=Profile 3"] } }
}
```

A directory marketplace is read in place: edit a plugin here, run `/reload-plugins`.

Elsewhere: `/plugin install <name> --marketplace yurifrl/claude-plugins`.

## Develop

```sh
claude plugin validate plugins/<name>
claude --plugin-dir plugins/<name>     # hot-reloads on save
tsc -p plugins/<name>                  # after the engine has loaded it once (lays .claude-plugin/types)
```
