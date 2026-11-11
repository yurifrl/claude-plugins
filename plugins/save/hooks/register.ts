import type { Register } from 'claude-code'

// Port of pi-yuri-extensions/modules/save.ts.
// /save [name] [description="..."] registers the current session with
// `cly as save <id> --provider claude --name <name> --description <desc> --override`.
// Handled entirely here: nothing is sent to the model, so /save never starts a turn.

const KV_RE = /(\w+)=(?:"([^"]*)"|(\S+))/g

type Overrides = { name?: string; description?: string }

export function parseSaveArgs(raw: string): Overrides {
  const kv: Record<string, string> = {}
  const rest = raw.replace(KV_RE, (_m, key: string, quoted?: string, bare?: string) => {
    kv[key] = quoted ?? bare ?? ''
    return ' '
  })
  const out: Overrides = {}
  const name = rest.trim()
  if (name) out.name = name
  if (kv.description !== undefined) out.description = kv.description
  return out
}

function slugify(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'session'
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

// The session's title lives in its transcript (<config>/projects/<dir>/<id>.jsonl):
// `/rename` appends {"type":"custom-title","customTitle"}, the auto title is
// {"type":"ai-title","aiTitle"}. The latest custom title wins, then the latest ai title.
const TITLE_SCRIPT =
  'grep -h -E \'"type":"(custom|ai)-title"\' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null'

export function pickTitle(lines: string): string {
  let custom = ''
  let ai = ''
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row !== 'object' || row === null) continue
      const r = row as { type?: unknown; customTitle?: unknown; aiTitle?: unknown }
      if (r.type === 'custom-title' && typeof r.customTitle === 'string') custom = r.customTitle.trim()
      if (r.type === 'ai-title' && typeof r.aiTitle === 'string') ai = r.aiTitle.trim()
    } catch {
      // a partial line: skip it
    }
  }
  return custom || ai
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'save',
      description: 'Save the current session with `cly as save` (does not message the agent)',
      argumentHint: '[name] [description="..."]',
    })
    return next(e)
  })

  on('command.run', { command: 'save' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const id = await $.session.id()
    const overrides = parseSaveArgs(e.args)
    let name = overrides.name
    if (name === undefined) {
      const { stdout: titles } = await $.process.run(['sh', '-c', TITLE_SCRIPT, 'sh', id])
      name = pickTitle(titles) || slugify(basename(cwd))
    }
    const description = overrides.description ?? `session in ${cwd}`

    const { exitCode, stdout, stderr } = await $.process.run([
      'cly', 'as', 'save', id,
      '--provider', 'claude',
      '--name', name,
      '--description', description,
      '--override',
    ])

    if (exitCode === 0) {
      $.ui.toast(`/save → ${name} (${id})`)
      return {}
    }
    const err = stderr.trim() || stdout.trim() || `exit ${exitCode}`
    return { text: `/save failed: ${err}`, exitCode: 1 }
  })
}
