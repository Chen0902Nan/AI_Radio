/** 默认在隔离服务和本地供应商替身上验证；--real --session-file=... 才调用真实供应商。 */
import { runProbe, failed } from './lib/probe-runner.mts'
import { openRadio } from './lib/browser-probe.mts'
import { playbackScenes } from './lib/playback-scenes.mts'
await runProbe('playback', async ctx => playbackScenes(ctx, await openRadio(ctx.env))).catch(failed)
