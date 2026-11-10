import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Candidate } from '../types'

// Port of pi-yuri-extensions/modules/respond.ts.
// /respond      → pane listing recent assistant messages; pick one to load it into the prompt.
// /respond <N>  → load the Nth latest assistant message (1 = most recent) directly.

const PANE = 'respond'
const PICKER_LIMIT = 15

const candidates = atom({ plugin: 'respond', key: 'candidates' } as const, [], {
  shape: 'candidates-1',
})

/** First non-empty line, whitespace-collapsed. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed.replace(/\s+/g, ' ')
  }
  return '(empty)'
}

async function assistantMessages($: EngineInterface): Promise<string[]> {
  const rows = await $.session.messages()
  return rows
    .filter(m => m.role === 'assistant')
    .map(m => m.text.trim())
    .filter(text => text.length > 0)
    .reverse()
}

async function load($: EngineInterface, text: string, index: number): Promise<void> {
  await $.prompt.fill({ text })
  $.ui.toast(`Assistant message #${index + 1} loaded into the prompt — edit and submit.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'respond',
      description: 'Respond to a previous assistant message: pick one, edit in the prompt, submit',
      argumentHint: '[N]',
    })

    return next(e)
  })

  on('command.run', { command: 'respond' }, async ($, e) => {
    const messages = await assistantMessages($)
    if (messages.length === 0) return { text: 'No assistant messages to respond to.' }

    const arg = e.args.trim()
    if (arg !== '') {
      const n = Number.parseInt(arg, 10)
      if (!Number.isInteger(n) || n < 1) return { text: 'Usage: /respond [N]' }
      const text = messages[n - 1]
      if (text === undefined) {
        return { text: `Only found ${messages.length} assistant message${messages.length === 1 ? '' : 's'}.` }
      }
      await load($, text, n - 1)
      return {}
    }

    const list: Candidate[] = messages.slice(0, PICKER_LIMIT).map((text, i) => {
      const lines = text.split('\n').length
      return { text, label: `#${i + 1}  ${firstLine(text)}  ·  ${lines} line${lines === 1 ? '' : 's'}` }
    })
    await update($, candidates, () => list)
    await $.ui.open({ id: PANE, title: 'Respond to…', focus: true, closeOnEscape: true })

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Select, Text } = $.ui.resolve(e)
    const list = await read($, candidates)

    if (list.length === 0) return <Text dimColor>No assistant messages.</Text>

    return (
      <Box flexDirection="column">
        <Text dimColor>Pick a message to load into the prompt (Esc closes).</Text>
        <Select
          key="pick"
          autoFocus
          options={list.map((c, i) => ({ value: String(i), label: c.label }))}
          onSelect={value => {
            const i = Number(value)
            const picked = list[i]
            if (picked === undefined) return
            void load($, picked.text, i).then(() => $.ui.close({ id: PANE }))
          }}
        />
      </Box>
    )
  })
}
