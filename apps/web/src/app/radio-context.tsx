/** React 只订阅运行时，不拥有播放、网络或配置生命周期。 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { PlaybackSnapshot } from '../playback/playback-controller'
import { getRadioInstance, type RadioContextValue } from '../orchestration/radio-runtime'
import type { AppStore } from '../orchestration/app-store'
export { getRadioInstance } from '../orchestration/radio-runtime'
export type { AppStore } from '../orchestration/app-store'
const RadioContext = createContext<RadioContextValue | null>(null)

export function RadioProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => {
    const inst = getRadioInstance()
    return inst
  }, [])
  useEffect(() => value.connect(), [value])
  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>
}

export function useRadio(): RadioContextValue {
  const ctx = useContext(RadioContext)
  if (!ctx) throw new Error('useRadio 必须在 RadioProvider 内使用')
  return ctx
}

export function usePlaybackSnapshot(): PlaybackSnapshot {
  return useSyncExternalStore(useRadio().playback.subscribe, useRadio().playback.getSnapshot, useRadio().playback.getSnapshot)
}

export function useAppStore(): AppStore {
  const store = useRadio().store
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
