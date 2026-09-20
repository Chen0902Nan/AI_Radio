/** 当前 ADR-0005：不喜欢硬排除具体版本，喜欢用于发现相似歌曲，不再验收旧抽样权重。 */
import { runProbe, failed } from './lib/probe-runner.mts'
import { sessionScenes } from './lib/session-scenes.mts'
await runProbe('session', sessionScenes).catch(failed)
