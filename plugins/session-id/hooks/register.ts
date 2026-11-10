import type { Register } from 'claude-code'

// Port of pi-yuri-extensions/modules/session-id.ts.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'session_id',
      description: 'Return the current Claude Code session id (UUID).',
      inputSchema: { type: 'object', properties: {} },
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__session-id__session_id' }, async $ => ({
    result: await $.session.id(),
  }))
}
