import type { Register } from 'claude-code'

// Port of pi-yuri-extensions/modules/session-id.ts.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'session_id',
      description: 'Return the current Claude Code session id (UUID).',
      inputSchema: { type: 'object', properties: {} },
    })

    await $.command.register({
      name: 'session-id',
      description: 'Show the current Claude Code session id',
    })

    return next(e)
  })

  on('command.run', { command: 'session-id' }, async $ => ({
    text: await $.session.id(),
  }))

  on('tool.call', { tool: 'mcp__session-id__session_id' }, async $ => ({
    result: await $.session.id(),
  }))
}
