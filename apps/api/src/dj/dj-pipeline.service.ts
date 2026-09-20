import { Injectable } from '@nestjs/common'
import * as contract from '@radio/contracts'
import * as fishMod from './fish.service'
import { FishService } from './fish.service'
import { createAudioCache, AudioCache } from './audio-cache'
import { DjScriptService, type SegueScriptInput } from './dj-script.service'
import { NeteaseService } from '../music/netease.service'
import { DbService } from '../persistence/db.service'
import { EventsService, type SseMessage } from '../events/events.service'
import { FISH, DJ as DJ_CONFIG, DJ_AUDIO_CACHE_DIR } from '../config/app-config'

import { createDjPipeline } from './pipeline'
export { createDjPipeline, PREVIEW_TEXT, type DjPipelineDeps } from './pipeline'

@Injectable()
export class DjPipelineService {
  private pipeline: ReturnType<typeof createDjPipeline>

  constructor(fish: FishService, djScript: DjScriptService, ncm: NeteaseService, db: DbService, private readonly events: EventsService) {
    this.cache = createAudioCache({ dir: DJ_AUDIO_CACHE_DIR })
    this.pipeline = createDjPipeline({
      sessions: {
        isOpen: id => db.isOpenSession(id),
        accept: req => db.acceptDjRequest(req),
        isCurrent: req => db.isCurrentDjRequest(req),
      },
      onStatus: (msg) => events.publish(msg),
      settings: () => db.listSettings(),
      getApiKey: () => FISH.apiKey(),
      resolveTarget: async (trackId: number) => {
        try {
          return await ncm.resolveTrack(trackId)
        } catch (err) {
          return { kind: 'unplayable', message: (err as Error).message }
        }
      },
      djScript: djScript,
      fish: fish,
      cache: this.cache,
    })
  }

  private cache: AudioCache

  configuration(): { ready: boolean; code: string | null; message: string; voiceReferenceId: string | null } {
    return this.pipeline.configuration()
  }

  async prepare(req: unknown): Promise<Record<string, unknown>> {
    const r = await this.pipeline.prepare(req)
    return r
  }

  job(segueId: string): { ok: boolean; code?: string; message?: string; job?: Record<string, unknown> } {
    return this.pipeline.job(segueId)
  }

  async cancel(segueId: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return this.pipeline.cancel(segueId)
  }

  invalidateSession(sessionId: string): void {
    return this.pipeline.invalidateSession(sessionId)
  }

  voiceConfigChanged(): { ok: true } {
    return this.pipeline.voiceConfigChanged()
  }

  async preview(input: { referenceId?: string; text?: string } = {}): Promise<Record<string, unknown>> {
    return this.pipeline.preview(input)
  }

  assetPath(assetId: string): string | null {
    return this.pipeline.assetPath(assetId)
  }

  cacheStats(): ReturnType<AudioCache['stats']> {
    return this.pipeline.cacheStats()
  }

  pipelineStats(): Record<string, unknown> {
    return this.pipeline.stats()
  }

  _dispose(): void {
    this.pipeline._dispose()
  }
}
