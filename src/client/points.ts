import { useEffect, useSyncExternalStore } from 'react'
import type { FilesnapProjection, RewindPoint, UiReply } from '../wire.ts'

/** One shared in-memory request per session/revision, regardless of bubble count. */
export function pointReader(read: () => Promise<UiReply>) {
  let revision: FilesnapProjection | undefined
  let points: readonly RewindPoint[] = []
  let generation = 0
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const snapshot = () => points
  const refresh = (next: FilesnapProjection | undefined) => {
    if (next === undefined || revision === next) return
    revision = next
    const ticket = ++generation
    void read().then(result => {
      if (ticket !== generation) return
      points = result.ok ? result.points ?? [] : []
      for (const listener of listeners) listener()
    }).catch(() => {
      if (ticket !== generation) return
      points = []
      for (const listener of listeners) listener()
    })
  }
  return function usePoints(projection: FilesnapProjection | undefined): readonly RewindPoint[] {
    useEffect(() => refresh(projection), [projection])
    return useSyncExternalStore(subscribe, snapshot, snapshot)
  }
}
