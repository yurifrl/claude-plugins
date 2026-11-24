import type { Register } from 'claude-code'

// omp-claude-agent (Claude side). Opens the real omp TUI in a Tern pane with the
// omp-claude-agent omp extension loaded, talks to it over that extension's unix
// socket, and submits a prompt here when an omp turn finishes unattended.

type Session = { name: string; dir: string; sock: string }
type Waiter = (reply: { text: string } | { error: string }) => void

const PLUGIN = 'omp-claude-agent'
const WAIT_MS = 20_000
const READY_TIMEOUT_MS = 90_000

const shq = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

// One watcher per omp session this Claude session owns; a blocking send
// parks a waiter so the watcher hands it the reply instead of waking Claude.
const watching = new Set<string>()
const waiters = new Map<string, Waiter>()
const closing = new Set<string>()

async function root($: any): Promise<string> {
  return `${await $.env.get('HOME')}/.cache/omp-claude-agent`
}

async function session($: any, name: string): Promise<Session> {
  const dir = `${await root($)}/${name}`
  return { name, dir, sock: `${dir}/sock` }
}

async function call($: any, s: Session, method: string, path: string, body?: unknown) {
  const response = await $.http.fetch(`http://bridge${path}`, {
    method,
    socketPath: s.sock,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const data = JSON.parse(response.text || '{}')
  if (!response.ok) throw new Error(data.error ?? `bridge answered ${response.status}`)
  return data
}

async function owner($: any, s: Session): Promise<string | undefined> {
  try {
    return (await $.fs.read(`${s.dir}/owner`)).trim()
  } catch {
    return undefined
  }
}

/** Every omp session whose bridge answers, with who owns it. */
async function live($: any) {
  const base = await root($)
  let entries: { name: string; kind: string }[] = []
  try {
    entries = await $.fs.list(base)
  } catch {
    return []
  }
  const me = await $.session.id()
  const found = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const s = await session($, entry.name)
    try {
      const state = await call($, s, 'GET', '/state')
      found.push({ session: s, state, isMine: (await owner($, s)) === me })
    } catch {
      // no bridge behind this folder: the session has ended
    }
  }
  return found
}

async function resolve($: any, name?: string): Promise<Session> {
  if (name) {
    const s = await session($, name)
    try {
      await call($, s, 'GET', '/state')
    } catch {
      throw new Error(`no live omp session named "${name}"; list them with the list tool`)
    }
    return s
  }
  const sessions = await live($)
  const mine = sessions.filter(entry => entry.isMine)
  const pick = mine.length === 1 ? mine : sessions
  const only = pick.length === 1 ? pick[0] : undefined
  if (only) return only.session
  if (pick.length === 0) throw new Error('no live omp session; start one with the open tool')
  throw new Error(`several live omp sessions, pass name: ${pick.map(e => e.session.name).join(', ')}`)
}

function watch($: any, s: Session, since: number) {
  if (watching.has(s.name)) return
  watching.add(s.name)
  void (async () => {
    let seen = since
    try {
      for (;;) {
        const waited = await call($, s, 'GET', `/wait?since=${seen}&ms=${WAIT_MS}`)
        if (!waited.settled) continue
        seen = waited.seq
        // Several watchers (a reloaded module, another session) may see the
        // same turn; only the first to ack it reports it.
        const { first } = await call($, s, 'POST', `/ack?seq=${seen}`)
        if (!first) continue
        const waiter = waiters.get(s.name)
        if (waiter) {
          waiters.delete(s.name)
          waiter({ text: waited.text })
        } else {
          void $.prompt.submit({
            text: `omp session "${s.name}" finished a turn. Its reply:\n\n${waited.text || '(no text)'}`,
          })
        }
      }
    } catch {
      // the bridge is gone: omp exited or its pane was closed
      const waiter = waiters.get(s.name)
      waiters.delete(s.name)
      waiter?.({ error: `omp session "${s.name}" ended` })
      if (!closing.delete(s.name) && !waiter) {
        void $.prompt.submit({ text: `omp session "${s.name}" ended (omp exited or its pane was closed).` })
      }
    } finally {
      watching.delete(s.name)
    }
  })()
}

async function open($: any, e: any) {
  const name: string = e.name ?? `omp-${String(await $.clock.now()).slice(-6)}`
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('name may hold letters, digits, ".", "_" and "-" only')
  const s = await session($, name)
  try {
    await call($, s, 'GET', '/state')
    throw new Error(`omp session "${name}" is already running`)
  } catch (error: any) {
    if (String(error?.message).includes('already running')) throw error
  }
  const cwd: string = e.cwd ?? (await $.session.cwd())
  await $.process.run(['mkdir', '-p', s.dir])
  await $.process.run(['rm', '-f', s.sock])
  await $.fs.write(`${s.dir}/owner`, await $.session.id())

  // Tern builds one shell line from the launch words and quotes them its own
  // way, so hand it only plain words: a script that holds the real command.
  if (!/^[A-Za-z0-9_@%+=:,./-]+$/.test(s.dir)) throw new Error(`state folder has characters Tern cannot launch from: ${s.dir}`)
  const command = ['exec', 'omp', '-e', `${$.plugin.root}/extension/omp-claude-agent.ts`, ...((e.omp_args as string[] | undefined) ?? [])]
  await $.fs.write(
    `${s.dir}/launch.sh`,
    `#!/bin/sh\nexport OMP_CLAUDE_AGENT_DIR=${shq(s.dir)}\n${command.map((word, index) => (index === 0 ? word : shq(word))).join(' ')}\n`,
  )
  const launch = ['sh', `${s.dir}/launch.sh`]
  const pane = await $.env.get('TERN_PANE')
  const place: string = e.place ?? 'right'
  const argv =
    place === 'tab' || !pane
      ? ['tern', 'new', 'tab', '--cwd', cwd, '--json', '--', ...launch]
      : ['tern', 'split', pane, place, '--cwd', cwd, '--json', '--', ...launch]
  const started = await $.process.run(argv)
  if (started.exitCode !== 0) throw new Error(`tern failed: ${started.stderr || started.stdout}`)
  let block: unknown
  try {
    block = JSON.parse(started.stdout).block
  } catch {
    block = undefined
  }

  const ready = await $.process.run(
    ['sh', '-c', 'for i in $(seq 300); do [ -S "$1" ] && exit 0; sleep 0.3; done; exit 1', 'sh', s.sock],
    { timeoutMs: READY_TIMEOUT_MS + 5_000 },
  )
  if (ready.exitCode !== 0) {
    throw new Error(`omp did not become ready; read its pane with: tern capture ${block} --surfaces`)
  }
  const state = await call($, s, 'GET', '/state')
  watch($, s, state.seq)
  return { name, block, cwd, sessionId: state.sessionId, model: state.model }
}

async function send($: any, e: any) {
  const s = await resolve($, e.name)
  if (typeof e.message !== 'string' || !e.message.trim()) throw new Error('message is empty')
  const state = await call($, s, 'GET', '/state')
  watch($, s, state.seq)
  const shouldWait = e.wait !== false
  const timeoutMs = Math.max(1, Number(e.timeout_seconds ?? 300)) * 1000

  let reply: Promise<{ text: string } | { error: string } | { timedOut: true }> | undefined
  let timer: { cancel: () => void } | undefined
  if (shouldWait) {
    reply = new Promise(done => {
      waiters.set(s.name, done)
      timer = $.clock.after(timeoutMs, () => {
        if (waiters.get(s.name) === done) waiters.delete(s.name)
        done({ timedOut: true } as never)
      })
    })
  }
  try {
    await call($, s, 'POST', '/prompt', { message: e.message, mode: e.mode ?? 'prompt' })
  } catch (error) {
    waiters.delete(s.name)
    timer?.cancel()
    throw error
  }
  if (!reply) return `Sent to omp session "${s.name}". You will be prompted with its reply when the turn ends.`
  const outcome = await reply
  timer?.cancel()
  if ('error' in outcome) throw new Error(outcome.error)
  if ('timedOut' in outcome) {
    const now = await call($, s, 'GET', '/state')
    return now.waitingOnUser
      ? `omp session "${s.name}" is asking the user a question in its pane. You will be prompted with its reply once the user answers and the turn ends.`
      : `omp session "${s.name}" is still working after ${timeoutMs / 1000}s. You will be prompted with its reply when the turn ends.`
  }
  return outcome.text || '(omp finished the turn with no text)'
}

async function close($: any, e: any) {
  const s = await resolve($, e.name)
  const state = await call($, s, 'GET', '/state')
  closing.add(s.name)
  await call($, s, 'POST', '/shutdown')
  await $.process.run(
    ['sh', '-c', 'for i in $(seq 50); do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.1; done; kill "$1"', 'sh', String(state.pid)],
    { timeoutMs: 15_000 },
  )
  if (state.block) await $.process.run(['tern', 'close', String(state.block)])
  return `closed omp session "${s.name}"`
}

const NAME = { type: 'string', description: 'Session name. Optional when exactly one session is live.' }
const tools: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  open: {
    description:
      'Open an omp (oh-my-pi) agent session: the real omp TUI in a Tern pane the user can watch and type in. Use whenever the user asks to open, start or spawn an omp session. Returns once omp is ready. From then on you are prompted automatically whenever a turn in that session finishes without a blocking send waiting for it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name (letters, digits, . _ -). Default: omp-<digits>.' },
        cwd: { type: 'string', description: "Directory omp works in. Default: this session's." },
        place: { type: 'string', enum: ['right', 'down', 'tab'], description: 'Split beside this pane, or a new tab. Default right.' },
        omp_args: { type: 'array', items: { type: 'string' }, description: 'Extra omp flags, e.g. ["--model","opus"].' },
      },
    },
  },
  send: {
    description:
      'Send a message to an omp session and return its final reply. mode "steer" redirects a running turn, "follow_up" queues behind it. With wait=false it returns at once and you are prompted with the reply when the turn ends. If the wait times out the turn keeps running and you are prompted later; do not poll.',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME,
        message: { type: 'string', description: 'Text for omp, delivered verbatim (slash commands are not expanded).' },
        mode: { type: 'string', enum: ['prompt', 'steer', 'follow_up'] },
        wait: { type: 'boolean', description: 'Wait for the reply. Default true.' },
        timeout_seconds: { type: 'number', description: 'How long to wait. Default 300.' },
      },
      required: ['message'],
    },
  },
  state: {
    description: 'State of an omp session: session id and file, model, cwd, whether it is idle or waiting on the user, and its last reply.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
  list: {
    description: 'List live omp sessions opened through this plugin, and which ones this Claude session owns.',
    inputSchema: { type: 'object', properties: {} },
  },
  abort: {
    description: 'Stop the turn an omp session is running.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
  close: {
    description: 'Shut an omp session down and close its Tern pane. Only for sessions opened for a finished side task, or when the user asks.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
}

async function state($: any, e: any) {
  return call($, await resolve($, e.name), 'GET', '/state')
}

async function list($: any) {
  const sessions = await live($)
  return sessions.map(({ session: s, state: st, isMine }) => ({
    name: s.name, isMine, isIdle: st.isIdle, cwd: st.cwd, model: st.model, sessionId: st.sessionId,
  }))
}

async function abort($: any, e: any) {
  const s = await resolve($, e.name)
  await call($, s, 'POST', '/abort')
  return `aborted the running turn in "${s.name}"`
}

async function run($: any, name: string, e: any): Promise<unknown> {
  switch (name) {
    case 'open': return open($, e)
    case 'send': return send($, e)
    case 'state': return state($, e)
    case 'list': return list($)
    case 'abort': return abort($, e)
    case 'close': return close($, e)
    default: throw new Error(`unknown tool: ${name}`)
  }
}

async function answer($: any, name: string, e: any) {
  try {
    const value = await run($, name, e)
    return { result: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
  } catch (error: any) {
    return { deny: String(error?.message ?? error) }
  }
}

async function resume($: any) {
  // Pick the sessions this Claude session opened back up after a reload or resume.
  try {
    for (const entry of await live($)) if (entry.isMine) watch($, entry.session, entry.state.seq)
  } catch {
    // nothing to watch
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const [name, spec] of Object.entries(tools)) {
      await $.tool.register({
        name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        isDeferred: name !== 'open' && name !== 'send',
      })
    }
    await resume($)
    return next(e)
  })

  on('tool.run', { tool: 'mcp__omp-claude-agent__open' }, ($, e) => answer($, 'open', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__send' }, ($, e) => answer($, 'send', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__state' }, ($, e) => answer($, 'state', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__list' }, ($, e) => answer($, 'list', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__abort' }, ($, e) => answer($, 'abort', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__close' }, ($, e) => answer($, 'close', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
}
