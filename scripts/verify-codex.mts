/** 默认供应商替身；显式 --real --session-file=... 时先执行真实选歌。 */
import { runProbe, failed } from './lib/probe-runner.mts'
import { codexScenes } from './lib/codex-scenes.mts'
await runProbe('codex', codexScenes).catch(failed)
