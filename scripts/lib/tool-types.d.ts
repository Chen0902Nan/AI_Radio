/** Arbitrary evidence and HTTP payloads are intentionally open at probe boundaries. */
export interface ProbeReport {
  at?: string
  base?: string
  checks?: Array<{ name: string; ok: unknown; detail?: unknown }>
  evidence?: Record<string, any>
  [field: string]: any
}

declare global {
  interface HTMLMediaElement { webkitAudioDecodedByteCount?: number }
  interface Window {
    /** Legacy live probes use the optional debug bridge; production code has its own contracts. */
    __radio: any
    __naturalPlayback: NaturalPlaybackTrace
    recordRadioMediaEvent(event: Record<string, unknown>): void
  }
}

interface MediaMoment { id: number; atMs: number; currentTime: number; duration: number; playbackRate: number }
export interface NaturalPlaybackTrace { trackId: number; start: MediaMoment | null; end: MediaMoment | null; seeks: MediaMoment[]; rateChanges: MediaMoment[] }
