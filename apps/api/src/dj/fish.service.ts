/** Fish Audio public adapter. Configuration, transport and audio validation have separate owners. */
import { Injectable } from '@nestjs/common'
import { evaluateAudioDurationImpl, validateVoiceConfig, type SynthesizeInput, type SynthesizeResult } from './fish-contract'
import { injectedSynthesis } from './fish-injection'
import { synthesizeProvider } from './fish-provider'

export { FREE_MODEL, MAX_AUDIO_BYTES, validateVoiceConfig, evaluateAudioDurationImpl, evaluateAudioDurationImpl as evaluateAudioDuration } from './fish-contract'
export type { SynthesizeInput, SynthesizeResult } from './fish-contract'
export { setFishMode, syntheticMp3 } from './fish-injection'

export async function synthesize(input: SynthesizeInput = {}): Promise<SynthesizeResult> {
  return await injectedSynthesis() ?? synthesizeProvider(input)
}

@Injectable()
export class FishService {
  evaluateAudioDuration(durationMs: number, opts?: { maxMs?: number; minMs?: number }): ReturnType<typeof evaluateAudioDurationImpl> {
    return evaluateAudioDurationImpl(durationMs, opts)
  }
  validateVoiceConfig(input?: Parameters<typeof validateVoiceConfig>[0]): ReturnType<typeof validateVoiceConfig> {
    return validateVoiceConfig(input)
  }
  synthesize(input: SynthesizeInput = {}): Promise<SynthesizeResult> { return synthesize(input) }
}
