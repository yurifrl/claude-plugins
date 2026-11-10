export type Candidate = { label: string; text: string }

import type { Shaped } from 'claude-code'

declare module 'claude-code' {
  interface PluginState {
    respond: { candidates: Shaped<Candidate[]> }
  }
}
