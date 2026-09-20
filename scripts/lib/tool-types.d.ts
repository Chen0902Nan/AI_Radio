/** Arbitrary evidence and HTTP payloads are intentionally open at probe boundaries. */
export interface ProbeReport {
  at?: string
  base?: string
  checks?: Array<{ name: string; ok: unknown; detail?: unknown }>
  evidence?: Record<string, unknown>
  [field: string]: unknown
}

declare global {
  interface HTMLMediaElement { webkitAudioDecodedByteCount?: number }
  interface Window {
    __naturalPlayback: NaturalPlaybackTrace
    recordRadioMediaEvent(event: Record<string, unknown>): void
  }
}

interface MediaMoment { id: number; atMs: number; currentTime: number; duration: number; playbackRate: number }
export interface NaturalPlaybackTrace { trackId: number; start: MediaMoment | null; end: MediaMoment | null; seeks: MediaMoment[]; rateChanges: MediaMoment[] }
