export type RowState = 'pending' | 'running' | 'ok' | 'error'

export type Row = {
  profile: string
  chrome?: string
  state: RowState
  detail?: string
  elapsedMs?: number
}

import type { Shaped } from 'claude-code'

declare module 'claude-code' {
  interface PluginState {
    aws: { rows: Shaped<Row[]> }
  }
}
