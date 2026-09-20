/** 隔离收听观测，默认120分钟；最小本地检查 --duration-min=0.02 --sample-ms=300。 */
import { runProbe, failed } from './lib/probe-runner.mts'
import { stabilityScenes } from './lib/stability-scenes.mts'
await runProbe('stability', stabilityScenes).catch(failed)
