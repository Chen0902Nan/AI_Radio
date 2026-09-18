// 构建期检查：@radio/contracts 的浏览器 ESM 产物可在 Vite 中导入（M1 验收项）。
// 该文件被 main 链路引用前仅由 typecheck/build 覆盖；M3 起由真实功能替代。
import { MAX_AUDIO_MS, makeTrackItem } from '@radio/contracts'

export const CONTRACTS_IMPORT_OK = MAX_AUDIO_MS === 30000 && typeof makeTrackItem === 'function'
