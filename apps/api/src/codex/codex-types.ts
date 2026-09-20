export interface CodexCandidate {
  id: number
  name: string
  artists: string
  album: string
  durationMs?: number
}

export interface CodexResult {
  ok: boolean
  picks?: Array<CodexCandidate & { reason: string }>
  rejected?: Array<{ id?: unknown; why: string }>
  code?: string
  message?: string
  meta?: Record<string, unknown>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: boolean
}


export type PickResponse = { raw: unknown; meta: Record<string, unknown> } | { failure: CodexResult }
