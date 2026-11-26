import type { Register } from 'claude-code'

// omp-claude-agent (Claude side). Talks to omp sessions through the
// omp-claude-agent omp extension's unix sockets: opens new ones in a Tern pane,
// attaches to running ones, and submits a prompt here when a turn finishes in a
// session this Claude session owns (the last one to open, attach to or send to it).

type Session = { name: string; dir: string; sock: string }

const PLUGIN = 'omp-claude-agent'
const WAIT_MS = 20_000
const READY_TIMEOUT_MS = 90_000

const shq = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

// One watcher per omp session this Claude session owns; while a blocking send
// waits on a session, the send reports its turn and the watcher stays quiet.
// A watcher stops once another Claude session takes the omp session over.
const watching = new Set<string>()
const sending = new Set<string>()
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

async function home($: any): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function extensionLink($: any): Promise<string> {
  return `${await home($)}/.omp/agent/extensions/${PLUGIN}`
}

/** Whether every omp the user starts loads the extension, so attach can reach it. */
async function installed($: any): Promise<{ isInstalled: boolean; via?: string }> {
  const link = await extensionLink($)
  if (await $.fs.exists(`${link}/extension/omp-claude-agent.ts`)) return { isInstalled: true, via: link }
  try {
    const listed = await $.process.run(['omp', 'plugin', 'list', '--json'], { timeoutMs: 20_000 })
    const plugins = JSON.parse(listed.stdout || '{}')
    const names = [...(plugins.npm ?? []), ...(plugins.marketplace ?? [])].map((p: any) => String(p?.name ?? p?.id ?? p))
    if (names.some(name => name.startsWith(PLUGIN))) return { isInstalled: true, via: 'omp plugin' }
  } catch {
    // omp missing or its listing changed: treat as not installed
  }
  return { isInstalled: false }
}

const INSTALL_HINT =
  'The omp extension is not installed globally, so only sessions started with the open tool are reachable. Offer the user `/omp-claude-agent install`, which makes every omp they start afterwards attachable.'

async function claim($: any, s: Session) {
  await $.fs.write(`${s.dir}/owner`, await $.session.id())
}

/** Stops driving: the omp drops the driven prompt and wakes nobody. */
async function release($: any, s: Session) {
  if ((await owner($, s)) === (await $.session.id())) {
    await $.process.run(['rm', '-f', `${s.dir}/owner`])
  }
}

async function owner($: any, s: Session): Promise<string | undefined> {
  try {
    return (await $.fs.read(`${s.dir}/owner`)).trim()
  } catch {
    return undefined
  }
}

/** Every omp session whose bridge answers, and whose wakes it sends to. */
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
      const holder = await owner($, s)
      found.push({ session: s, state, isMine: holder === me, isOwned: holder !== undefined && holder !== me })
    } catch {
      // No bridge behind this folder: that omp has ended. A folder named for a
      // pid that is gone (omp killed before it could clean up) is removed.
      const pid = /^omp-(\d+)$/.exec(entry.name)?.[1]
      if (pid) await $.process.run(['sh', '-c', 'kill -0 "$1" 2>/dev/null || rm -rf "$2"', 'sh', pid, s.dir])
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
        // A blocking send in this session reports this turn itself.
        if (sending.has(s.name)) continue
        // Another Claude session took this omp session over: its wakes are theirs.
        if ((await owner($, s)) !== (await $.session.id())) break
        // Two watchers in this session (a reloaded module) may see the same
        // turn; only the first to ack it reports it.
        const { first } = await call($, s, 'POST', `/ack?seq=${seen}`)
        if (!first) continue
        void $.prompt.submit({
          text: `omp session "${s.name}" finished a turn. Its reply:\n\n${waited.text || '(no text)'}\n\nIf its task is done, close the session.`,
        })
      }
    } catch {
      // The bridge is gone: omp exited or its pane was closed. Tell the owner
      // only; a pid folder omp removed on exit has no owner file left, and
      // this watcher was the owner's as of its last turn.
      try {
        const holder = await owner($, s)
        const isMine = holder === undefined || holder === (await $.session.id())
        if (!closing.delete(s.name) && !sending.has(s.name) && isMine) {
          void $.prompt.submit({ text: `omp session "${s.name}" ended (omp exited or its pane was closed).` })
        }
      } catch {
        // this module is unloading: nothing to tell
      }
    } finally {
      watching.delete(s.name)
    }
  })()
}

/**
 * Where omp opens: a split to the right, always, unless the person's own recent
 * words ask for a tab or a split below. A model's own layout preference (say,
 * tabs for several workers) does not count.
 */
async function placement($: any, asked: unknown): Promise<'right' | 'down' | 'tab'> {
  if (asked !== 'down' && asked !== 'tab') return 'right'
  const words = asked === 'tab' ? /\b(tabs?|abas?)\b/i : /\b(down|below|bottom|under|vertical|baixo|embaixo)\b/i
  try {
    const recent = await $.session.messages({ last: 12 })
    if ('deny' in recent) return 'right'
    const said = recent
      .filter((m: any) => m.role === 'user' && typeof m.text === 'string' && !m.text.startsWith('<'))
      .slice(-3)
      .some((m: any) => words.test(m.text))
    return said ? asked : 'right'
  } catch {
    return 'right'
  }
}

// ---- hosts ---------------------------------------------------------------
//
// Rules (plain, enforced here):
// 1. One omp session for this Claude session: a Tern split right of Claude's pane.
// 2. More than one: every one lives in herdr, one tab each. Opening a second
//    session moves the first (Tern) one into herdr, resuming its conversation.
// 3. The herdr session is named claude-<this Claude session id> and is shown in
//    a Tern split right of Claude's pane.
// 4. A herdr tab is labelled with the session's tk task id, else its name.

type Herdr = { session: string; tab: string; pane: string }

function herdrName(claudeId: string) {
  return `claude-${claudeId}`
}

/** A herdr agent name: [a-z][a-z0-9_-]{0,31}. */
function agentName(name: string) {
  const clean = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return (/^[a-z]/.test(clean) ? clean : `o-${clean}`).slice(0, 32)
}

async function herdrJson($: any, argv: string[], timeoutMs = 30_000) {
  const ran = await $.process.run(['herdr', ...argv], { timeoutMs })
  if (ran.exitCode !== 0) throw new Error(`herdr ${argv.slice(0, 4).join(' ')} failed: ${(ran.stderr || ran.stdout).slice(0, 400)}`)
  return JSON.parse(ran.stdout)
}

/** The herdr session for this Claude session, started in a Tern split when it is not running. */
async function herdrSession($: any): Promise<{ session: string; workspace: string }> {
  const session = herdrName(await $.session.id())
  const listed = await herdrJson($, ['session', 'list', '--json'])
  const isRunning = (listed.sessions ?? []).some((x: any) => x.name === session && x.running)
  if (!isRunning) {
    const pane = (await $.env.get('TERN_PANE')) ?? '@focused'
    const started = await $.process.run(['tern', 'split', pane, 'right', '--cwd', await $.session.cwd(), '--json', '--', 'herdr', '--session', session])
    if (started.exitCode !== 0) throw new Error(`tern failed to show herdr: ${started.stderr || started.stdout}`)
    const up = await $.process.run(
      ['sh', '-c', 'for i in $(seq 100); do herdr --session "$1" workspace list >/dev/null 2>&1 && exit 0; sleep 0.3; done; exit 1', 'sh', session],
      { timeoutMs: 40_000 },
    )
    if (up.exitCode !== 0) throw new Error(`herdr session ${session} did not start`)
  }
  const workspaces = await herdrJson($, ['--session', session, 'workspace', 'list'])
  const workspace = workspaces.result?.workspaces?.[0]?.workspace_id
  if (!workspace) throw new Error(`herdr session ${session} has no workspace`)
  return { session, workspace }
}

async function prepare($: any, s: Session, e: any) {
  await $.process.run(['mkdir', '-p', s.dir])
  await $.process.run(['rm', '-f', s.sock, `${s.dir}/block`, `${s.dir}/herdr`])
  await claim($, s)
  await $.fs.write(`${s.dir}/args.json`, JSON.stringify({ omp_args: e.omp_args ?? [], task: e.task ?? null }))
}

async function waitReady($: any, s: Session, where: string) {
  const ready = await $.process.run(
    ['sh', '-c', 'for i in $(seq 300); do [ -S "$1" ] && exit 0; sleep 0.3; done; exit 1', 'sh', s.sock],
    { timeoutMs: READY_TIMEOUT_MS + 5_000 },
  )
  if (ready.exitCode !== 0) throw new Error(`omp did not become ready; read ${where}`)
  return call($, s, 'GET', '/state')
}

async function launchTern($: any, s: Session, cwd: string, ompArgs: string[], asked: unknown) {
  // Tern builds one shell line from the launch words and quotes them its own
  // way, so hand it only plain words: a script that holds the real command.
  if (!/^[A-Za-z0-9_@%+=:,./-]+$/.test(s.dir)) throw new Error(`state folder has characters Tern cannot launch from: ${s.dir}`)
  const command = ['exec', 'omp', '-e', `${$.plugin.root}/extension/omp-claude-agent.ts`, ...ompArgs]
  await $.fs.write(
    `${s.dir}/launch.sh`,
    `#!/bin/sh\nexport OMP_CLAUDE_AGENT_DIR=${shq(s.dir)}\n${command.map((word, index) => (index === 0 ? word : shq(word))).join(' ')}\n`,
  )
  const launch = ['sh', `${s.dir}/launch.sh`]
  const pane = (await $.env.get('TERN_PANE')) ?? '@focused'
  const place = await placement($, asked)
  const argv =
    place === 'tab'
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
  // close shuts this pane: the one `open` made, never one omp found itself in.
  if (block !== undefined) await $.fs.write(`${s.dir}/block`, String(block))
  const state = await waitReady($, s, `its pane with: tern capture ${block} --surfaces`)
  return { host: 'tern', place, block, state }
}

async function launchHerdr($: any, s: Session, cwd: string, ompArgs: string[], label: string) {
  const { session, workspace } = await herdrSession($)
  const created = await herdrJson($, [
    '--session', session, 'tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label,
    '--env', `OMP_CLAUDE_AGENT_DIR=${s.dir}`, '--no-focus',
  ])
  const tab: string = created.result.tab.tab_id
  const pane: string = created.result.root_pane.pane_id
  const where: Herdr = { session, tab, pane }
  await $.fs.write(`${s.dir}/herdr`, JSON.stringify(where))
  // A tab's shell drops what is typed before its prompt is up (the first tab
  // of a fresh herdr server is slow): wait for the prompt, and start again
  // once if omp still never came up.
  await $.process.run(
    ['herdr', '--session', session, 'pane', 'wait-output', pane, '--regex', '\\S', '--timeout', '20000'],
    { timeoutMs: 25_000 },
  )
  await $.clock.sleep(500)
  const start = () =>
    herdrJson(
      $,
      ['--session', session, 'agent', 'start', agentName(s.name), '--kind', 'omp', '--pane', pane, '--timeout', '60000',
        '--', '-e', `${$.plugin.root}/extension/omp-claude-agent.ts`, ...ompArgs],
      70_000,
    )
  try {
    await start()
  } catch {
    if (!(await $.fs.exists(s.sock))) await start()
  }
  const state = await waitReady($, s, `the herdr tab with: herdr --session ${session} pane read ${pane} --source recent-unwrapped`)
  return { host: 'herdr', herdr: where, state }
}

/** Moves a session of this Claude session from Tern into a herdr tab, keeping its conversation. */
async function moveToHerdr($: any, s: Session) {
  const state = await call($, s, 'GET', '/state')
  let saved: any = {}
  try {
    saved = JSON.parse(await $.fs.read(`${s.dir}/args.json`))
  } catch {
    saved = {}
  }
  let block: string | undefined
  try {
    block = (await $.fs.read(`${s.dir}/block`)).trim() || undefined
  } catch {
    block = undefined
  }
  closing.add(s.name)
  await call($, s, 'POST', '/shutdown')
  await $.process.run(
    ['sh', '-c', 'for i in $(seq 50); do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.1; done; kill "$1"', 'sh', String(state.pid)],
    { timeoutMs: 15_000 },
  )
  if (block) await $.process.run(['tern', 'close', block])
  // omp saves a session file only once it has a message: an empty session
  // starts fresh in herdr rather than failing to resume.
  const base = (saved.omp_args ?? []).filter((x: string, i: number, all: string[]) => x !== '--resume' && all[i - 1] !== '--resume')
  const canResume = Boolean(state.sessionFile) && (await $.fs.exists(state.sessionFile))
  const args = canResume ? [...base, '--resume', state.sessionId] : base
  await prepare($, s, { omp_args: saved.omp_args ?? [], task: saved.task ?? undefined })
  const moved = await launchHerdr($, s, state.cwd, args, saved.task ?? s.name)
  watch($, s, moved.state.seq)
  return s.name
}

/** This Claude session's live omp sessions, and which of them sit in Tern. */
async function mine($: any, except?: string) {
  const owned = (await live($)).filter(entry => entry.isMine && entry.session.name !== except)
  const inTern = []
  for (const entry of owned) if (!(await $.fs.exists(`${entry.session.dir}/herdr`))) inTern.push(entry)
  return { owned, inTern }
}

async function open($: any, e: any) {
  const name: string = e.name ?? `omp-${String(await $.clock.now()).slice(-6)}`
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) throw new Error('name may hold up to 40 letters, digits, ".", "_" and "-"')
  const s = await session($, name)
  try {
    await call($, s, 'GET', '/state')
    throw new Error(`omp session "${name}" is already running`)
  } catch (error: any) {
    if (String(error?.message).includes('already running')) throw error
  }
  const cwd: string = e.cwd ?? (await $.session.cwd())
  const ompArgs: string[] = e.omp_args ?? []

  // Rule 2: a second session puts them all in herdr.
  const { owned, inTern } = await mine($, name)
  const useHerdr = e.several === true || owned.length > 0
  const moved = []
  if (useHerdr) for (const entry of inTern) moved.push(await moveToHerdr($, entry.session))

  await prepare($, s, e)
  const opened = useHerdr
    ? await launchHerdr($, s, cwd, ompArgs, e.task ?? name)
    : await launchTern($, s, cwd, ompArgs, e.place)
  watch($, s, opened.state.seq)
  const { state, ...where } = opened as any
  return {
    name, cwd, sessionId: state.sessionId, model: state.model, ...where,
    ...(moved.length ? { movedToHerdr: moved } : {}),
    ...(!useHerdr && e.place && e.place !== (opened as any).place ? { note: `opened as a right split: "${e.place}" needs the user to ask for it` } : {}),
  }
}

async function send($: any, e: any) {
  const s = await resolve($, e.name)
  if (typeof e.message !== 'string' || !e.message.trim()) throw new Error('message is empty')
  const before = await call($, s, 'GET', '/state')
  await claim($, s) // whoever talks to it hears back from it
  watch($, s, before.seq)
  if (e.wait === false) {
    await call($, s, 'POST', '/prompt', { message: e.message, mode: e.mode ?? 'prompt' })
    return `Sent to omp session "${s.name}". You will be prompted with its reply when the turn ends.`
  }

  // Wait through the bridge's long-poll, a $ call, so the hook's own time
  // budget does not run while omp works. The token reserves the turn this call
  // starts: no watcher (another copy of this module, another Claude session)
  // can ack it first. The marker keeps this module's watcher quiet meanwhile.
  const token = `${await $.session.id()}-${await $.clock.now()}`
  sending.add(s.name)
  const deadline = (await $.clock.now()) + Math.max(1, Number(e.timeout_seconds ?? 300)) * 1000
  let isAcked = false
  try {
    await call($, s, 'POST', '/prompt', { message: e.message, mode: e.mode ?? 'prompt', token })
    let since = before.seq
    for (;;) {
      const left = deadline - (await $.clock.now())
      if (left <= 0) break
      const waited = await call($, s, 'GET', `/wait?since=${since}&ms=${Math.min(WAIT_MS, left)}`)
      if (!waited.settled) continue
      since = waited.seq
      if ((await call($, s, 'POST', `/ack?seq=${since}&token=${encodeURIComponent(token)}`)).first) {
        isAcked = true
        return waited.text || '(omp finished the turn with no text)'
      }
    }
  } catch (error: any) {
    closing.add(s.name) // this error tells the caller; no "ended" wake as well
    throw new Error(`omp session "${s.name}" ended or stopped answering: ${error?.message ?? error}`)
  } finally {
    sending.delete(s.name)
    if (!isAcked) await call($, s, 'POST', `/release?token=${encodeURIComponent(token)}`).catch(() => undefined)
  }
  // A turn that settled as the wait ran out is still this call's to report.
  const now = await call($, s, 'GET', '/state')
  if (now.seq > before.seq && (await call($, s, 'POST', `/ack?seq=${now.seq}`)).first) {
    const settled = await call($, s, 'GET', `/wait?since=${now.seq - 1}&ms=1`)
    return settled.text || '(omp finished the turn with no text)'
  }
  return now.waitingOnUser
    ? `omp session "${s.name}" is asking the user a question in its pane. You will be prompted with its reply once the user answers and the turn ends.`
    : `omp session "${s.name}" is still working. You will be prompted with its reply when the turn ends.`
}

async function close($: any, e: any) {
  const s = await resolve($, e.name)
  const state = await call($, s, 'GET', '/state')
  let block: string | undefined
  try {
    block = (await $.fs.read(`${s.dir}/block`)).trim() || undefined
  } catch {
    block = undefined // omp the user started: their pane may hold their shell
  }
  closing.add(s.name)
  try {
    await call($, s, 'POST', '/shutdown')
  } catch (error) {
    closing.delete(s.name)
    throw error
  }
  await $.process.run(
    ['sh', '-c', 'for i in $(seq 50); do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.1; done; kill "$1"', 'sh', String(state.pid)],
    { timeoutMs: 15_000 },
  )
  if (block) await $.process.run(['tern', 'close', block])
  try {
    const where: Herdr = JSON.parse(await $.fs.read(`${s.dir}/herdr`))
    await $.process.run(['herdr', '--session', where.session, 'tab', 'close', where.tab])
  } catch {
    // not in herdr
  }
  return `closed omp session "${s.name}"`
}

async function detach($: any, e: any) {
  const s = await resolve($, e.name)
  if ((await owner($, s)) !== (await $.session.id())) return `omp session "${s.name}" is not driven by this Claude session`
  await release($, s)
  return `Detached from omp session "${s.name}": it runs on as a plain omp, without the driven prompt or wake-ups.`
}

async function attach($: any, e: any) {
  const sessions = await live($)
  let target = e.name ? sessions.find(entry => entry.session.name === e.name) : undefined
  if (e.name && !target) throw new Error(`no live omp session named "${e.name}"; list them with the list tool`)
  if (!target) {
    const candidates = sessions.filter(entry => !entry.isMine)
    const unowned = candidates.filter(entry => !entry.isOwned)
    const pick = unowned.length === 1 ? unowned : candidates
    if (pick.length === 1) target = pick[0]
    else if (pick.length === 0) {
      const { isInstalled } = await installed($)
      throw new Error(isInstalled ? 'no omp session to attach to; start one with the open tool' : `no omp session to attach to. ${INSTALL_HINT}`)
    } else {
      throw new Error(`several omp sessions, pass name: ${pick.map(entry => `${entry.session.name} (${entry.state.cwd})`).join(', ')}`)
    }
  }
  if (!target) throw new Error('no omp session to attach to')
  await claim($, target.session)
  watch($, target.session, target.state.seq)
  const st = target.state
  return {
    name: target.session.name, pid: st.pid, cwd: st.cwd, model: st.model, sessionId: st.sessionId,
    isIdle: st.isIdle, lastText: st.lastText, tookOverFromAnotherClaude: target.isOwned,
  }
}

const NAME = { type: 'string', description: 'Session name. Optional when exactly one session is live.' }
const tools: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  open: {
    description:
      'Open an omp (oh-my-pi) agent session: the real omp TUI, in a Tern split right of this pane when it is your only one, else in its own tab of your herdr session (opening a second one moves the first into herdr). Use whenever the user asks to open, start or spawn an omp session. Returns once omp is ready. From then on you are prompted automatically whenever a turn in that session finishes without a blocking send waiting for it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name (letters, digits, . _ -). Default: omp-<digits>.' },
        cwd: { type: 'string', description: "Directory omp works in. Default: this session's." },
        place: { type: 'string', enum: ['right', 'down', 'tab'], description: 'Leave unset: omp always opens as a split to the right of this pane. "down" or "tab" is honored only when the user asked for it in their own recent message; never pass it for your own layout preference, such as several sessions at once.' },
        omp_args: { type: 'array', items: { type: 'string' }, description: 'Extra omp flags, e.g. ["--model","opus"].' },
        task: { type: 'string', description: 'tk task id this session works on. Becomes its herdr tab label. Pass it whenever the work has a task.' },
        several: { type: 'boolean', description: 'Set true when you are about to open more than one omp session: they all go to herdr from the first one.' },
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
  attach: {
    description:
      "Attach to an omp session that is already running, opened by the user or another Claude session, so you can send to it and are prompted when its turns finish (taking those wake-ups over from any other Claude session). Without a name, attaches to the only one nobody owns. Use when the user asks to take over, connect to or use an existing omp session.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Session name from the list tool.' } } },
  },
  detach: {
    description:
      'Stop driving an omp session without closing it: omp drops the "driven by Claude" system prompt (and may use Plannotator again) and this session gets no more wake-ups from it. Use when the user wants the omp back for themselves.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
  state: {
    description: 'State of an omp session: session id and file, model, cwd, whether it is idle or waiting on the user, and its last reply.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
  list: {
    description: 'List running omp sessions you can reach (owner "me", "other" Claude session, or "none"), and whether the omp extension is installed globally.',
    inputSchema: { type: 'object', properties: {} },
  },
  abort: {
    description: 'Stop the turn an omp session is running.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
  close: {
    description: 'Shut an omp session down and close its Tern pane or herdr tab. Call it as soon as the session task is done: never leave a finished omp session running. On an omp the user started, only when they ask.',
    inputSchema: { type: 'object', properties: { name: NAME } },
  },
}

async function state($: any, e: any) {
  return call($, await resolve($, e.name), 'GET', '/state')
}

async function list($: any) {
  const [sessions, install] = await Promise.all([live($), installed($)])
  return {
    sessions: sessions.map(({ session: s, state: st, isMine, isOwned }) => ({
      name: s.name, owner: isMine ? 'me' : isOwned ? 'other' : 'none', openedByPlugin: st.openedByPlugin,
      isIdle: st.isIdle, cwd: st.cwd, model: st.model, sessionId: st.sessionId, pid: st.pid,
    })),
    extensionInstalled: install.isInstalled,
    ...(install.isInstalled ? {} : { note: INSTALL_HINT }),
  }
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
    case 'attach': return attach($, e)
    case 'detach': return detach($, e)
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

async function installCommand($: any, args: string): Promise<string> {
  const action = args.trim() || 'status'
  const link = await extensionLink($)
  const install = await installed($)
  if (action === 'status') {
    const sessions = await live($)
    return install.isInstalled
      ? `omp extension installed (${install.via}). ${sessions.length} omp session(s) reachable.`
      : `omp extension not installed: only omp started with the open tool (or before an uninstall) is reachable, ${sessions.length} session(s) now. Run /omp-claude-agent install to make every omp you start attachable.`
  }
  if (action === 'install') {
    if (install.isInstalled) return `Already installed (${install.via}).`
    // A link left dangling (the plugin moved, or a cached version was removed)
    // is replaced; anything else at that path is left for the user.
    const made = await $.process.run([
      'sh', '-c',
      'mkdir -p "$(dirname "$2")" && { [ -L "$2" ] && [ ! -e "$2" ] && rm "$2"; ln -s "$1" "$2"; }',
      'sh', $.plugin.root, link,
    ])
    if (made.exitCode !== 0) return `Install failed: ${made.stderr || made.stdout}`
    return [
      `Installed: ${link} -> ${$.plugin.root}`,
      'omp sessions started from now on are attachable; restart a running omp to include it.',
      'If ~/.omp/agent/extensions lives in a dotfiles repo, commit the new link there to keep it declarative.',
    ].join('\n')
  }
  if (action === 'uninstall') {
    const removed = await $.process.run(['sh', '-c', '[ -L "$1" ] && rm "$1"', 'sh', link])
    if (removed.exitCode !== 0) {
      return install.isInstalled
        ? `Not removed: ${install.via} is not a link this command made. Remove it by hand (omp plugin uninstall, or delete it).`
        : 'Not installed.'
    }
    return `Removed ${link}. Running omp sessions keep it until they restart.`
  }
  return 'Usage: /omp-claude-agent [status|install|uninstall]'
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
        isDeferred: !['open', 'send', 'attach'].includes(name),
      })
    }
    await $.command.register({
      name: PLUGIN,
      description: 'omp extension: status, install (every omp you start becomes attachable), uninstall',
      argumentHint: '[status|install|uninstall]',
    })
    await resume($)
    return next(e)
  })

  // A Claude session that ends stops driving its omp sessions.
  on('session.end', async ($, e, next) => {
    try {
      for (const entry of await live($)) if (entry.isMine) await release($, entry.session)
    } catch {
      // nothing to release
    }
    return next(e)
  })

  on('command.run', { command: 'omp-claude-agent' }, async ($, e) => ({ text: await installCommand($, e.args) })).catch(() => ({ text: 'omp-claude-agent: the command failed' }))

  on('tool.run', { tool: 'mcp__omp-claude-agent__open' }, ($, e) => answer($, 'open', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__send' }, ($, e) => answer($, 'send', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__attach' }, ($, e) => answer($, 'attach', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__detach' }, ($, e) => answer($, 'detach', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__state' }, ($, e) => answer($, 'state', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__list' }, ($, e) => answer($, 'list', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__abort' }, ($, e) => answer($, 'abort', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
  on('tool.run', { tool: 'mcp__omp-claude-agent__close' }, ($, e) => answer($, 'close', e)).catch(() => ({ deny: 'omp-claude-agent failed to answer' }))
}
