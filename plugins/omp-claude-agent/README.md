# omp-claude-agent

Lets Claude Code open the real omp (oh-my-pi) TUI in a Tern pane and drive it with native tools: open a session, send it a prompt and get the reply, read its state, abort or close it. Claude is prompted automatically whenever an omp turn finishes unattended.

Two halves:

- `hooks/register.ts`: the Claude Code hooks module. It registers the tools and runs a watcher per open session.
- `extension/omp-claude-agent.ts`: an omp extension loaded with `omp -e` into the sessions the plugin opens. It serves HTTP on a unix socket under `~/.cache/omp-claude-agent/<name>/`.

Requires `tern` and `omp` on `PATH`.
