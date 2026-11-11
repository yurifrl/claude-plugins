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
    const name = overrides.name ?? slugify(basename(cwd))
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
