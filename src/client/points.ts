import { useEffect, useSyncExternalStore } from 'react'
import type { FilesnapProjection, RewindPoint, UiReply } from '../wire.ts'
import { pointStore } from './point-store.ts'

/** React binding of the shared points store; one reader per session. */
export function pointReader(read: () => Promise<UiReply>) {
  const store = pointStore(read)
  return function usePoints(projection: FilesnapProjection | undefined): readonly RewindPoint[] {
    useEffect(() => store.refresh(projection), [projection])
    return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  }
}
