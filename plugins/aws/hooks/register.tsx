import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Row, RowState } from '../types'

// Port of pi-yuri-extensions/modules/aws. `/aws login [profiles...]` runs
// `aws sso login --no-browser` per profile, sequentially, and opens each SSO
// URL in the browser under that profile's Chrome profile. Progress shows in a
// band above the prompt. Config: pluginConfigs["aws@yurifrl"].options.

const TIMEOUT_MS = 300_000
const URL_REGEX = /https?:\/\/\S+/

const rows = atom({ plugin: 'aws', key: 'rows' } as const, [], { shape: 'rows-1' })

const GLYPH: Record<RowState, string> = { pending: '○', running: '⟳', ok: '✓', error: '✕' }
const COLOR: Record<RowState, string | undefined> = {
  pending: undefined,
  running: 'suggestion',
  ok: 'success',
  error: 'error',
}

type Config = {
  profiles: string[]
  chromeProfiles: Record<string, string>
  defaultChromeProfile?: string
  browserApp: string
}

function list(value: PluginOptions[string] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(v => v.trim() !== '')
  if (typeof value === 'string' && value.trim() !== '') return value.split(',').map(v => v.trim())
  return []
}

function readConfig(options: PluginOptions): Config {
  const chromeProfiles: Record<string, string> = {}
  for (const entry of list(options.chromeProfiles)) {
    const at = entry.indexOf('=')
    if (at > 0) chromeProfiles[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
  }
  const def = typeof options.defaultChromeProfile === 'string' ? options.defaultChromeProfile.trim() : ''
  const app = typeof options.browserApp === 'string' ? options.browserApp.trim() : ''
  return {
    profiles: list(options.profiles),
    chromeProfiles,
    defaultChromeProfile: def || undefined,
    browserApp: app || 'Google Chrome',
  }
}

async function patch($: EngineInterface, profile: string, change: Partial<Row>): Promise<void> {
  await update($, rows, all => all.map(r => (r.profile === profile ? { ...r, ...change } : r)))
}

async function openUrl($: EngineInterface, cfg: Config, chrome: string | undefined, url: string): Promise<void> {
  const args = chrome ? ['--args', `--profile-directory=${chrome}`, url] : [url]
  await $.process.run(['/usr/bin/open', '-na', cfg.browserApp, ...args])
}

async function loginOne($: EngineInterface, cfg: Config, row: Row): Promise<void> {
  const child = $.process.spawn({ argv: ['aws', 'sso', 'login', '--no-browser', '--profile', row.profile] })
  const timer = $.clock.after(TIMEOUT_MS, () => void child.return(undefined as never))
  let output = ''
  let opened = false
  try {
    for await (const { text } of child) {
      output += text
      if (!opened) {
        const url = URL_REGEX.exec(output)?.[0]
        if (url) {
          opened = true
          await openUrl($, cfg, row.chrome, url)
          const where = row.chrome ? ` (${row.chrome})` : ''
          await patch($, row.profile, { detail: `opened in ${cfg.browserApp}${where}, waiting for approval…` })
        }
      }
      if (/Successfully logged into/i.test(text)) await patch($, row.profile, { detail: 'finalizing…' })
    }
    const { code, signal } = await child.result
    if (code !== 0) {
      const last = output.trim().split('\n').pop()
      throw new Error(signal ? `killed (${signal})` : last || `exit ${code}`)
    }
  } catch (err) {
    if (!opened && output === '') throw new Error(`timed out or failed to start: ${String(err)}`)
    throw err
  } finally {
    timer.cancel()
  }
}

async function loginAll($: EngineInterface, cfg: Config, profiles: string[]): Promise<void> {
  await update($, rows, () =>
    profiles.map(profile => ({
      profile,
      chrome: cfg.chromeProfiles[profile] ?? cfg.defaultChromeProfile,
      state: 'pending' as const,
    })),
  )

  const ok: string[] = []
  const failed: string[] = []
  for (const row of await read($, rows)) {
    const t0 = await $.clock.now()
    await patch($, row.profile, { state: 'running', detail: 'requesting SSO url…' })
    try {
      await loginOne($, cfg, row)
      await patch($, row.profile, { state: 'ok', detail: 'logged in', elapsedMs: (await $.clock.now()) - t0 })
      ok.push(row.profile)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      await patch($, row.profile, { state: 'error', detail, elapsedMs: (await $.clock.now()) - t0 })
      failed.push(`${row.profile}: ${detail}`)
    }
  }

  await $.clock.sleep(1500)
  await update($, rows, () => [])
  if (failed.length > 0) {
    $.ui.toast(`AWS login: ✓ ${ok.join(', ') || 'none'} · ✕ ${failed.join('; ')}`)
  } else {
    $.ui.toast(`✓ AWS SSO login: ${ok.join(', ')}`)
  }
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  let running = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aws',
      description: 'aws: /aws login [profiles...] — SSO login for configured AWS profiles',
      argumentHint: 'login [profiles...]',
    })

    return next(e)
  })

  on('command.run', { command: 'aws' }, async ($, e) => {
    const parts = e.args.trim().split(/\s+/).filter(Boolean)
    if ((parts[0] ?? '').toLowerCase() !== 'login') return { text: 'aws: usage — /aws login [profiles...]' }
    if (running) return { text: 'aws: a login is already running.' }

    const profiles = parts.length > 1 ? parts.slice(1) : cfg.profiles
    if (profiles.length === 0) {
      return { text: 'aws: no profiles configured (set pluginConfigs aws options.profiles, or pass profiles)' }
    }

    running = true
    void loginAll($, cfg, profiles)
      .catch(err => $.ui.toast(`aws: ${String(err)}`))
      .finally(() => {
        running = false
      })

    return { text: `aws: logging into ${profiles.join(', ')}…` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, rows)
    if (all.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="suggestion">☁ AWS Login <Text dimColor>· {cfg.browserApp}</Text></Text>
        {all.map(r => (
          <Text>
            <Text color={COLOR[r.state]} dimColor={r.state === 'pending'}>
              {GLYPH[r.state]} {r.profile.padEnd(10)}
            </Text>
            <Text dimColor>
              {r.chrome ? ` [${r.chrome}]` : ''}
              {r.detail ? `  ${r.detail}` : ''}
              {r.elapsedMs !== undefined ? `  ${(r.elapsedMs / 1000).toFixed(1)}s` : ''}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
