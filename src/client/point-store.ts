/** Request store behind the rewind points; React-free so plain Node can test it. */
import type { FilesnapProjection, RewindPoint, UiReply } from '../wire.ts'

/** One shared in-memory request per session/revision, regardless of bubble count. */
export interface PointStore {
  /** Note the projection that arrived; reads whenever it is a new revision. */
  refresh: (projection: FilesnapProjection | undefined) => void
  /** The latest settled points; a stable reference between settles. */
  snapshot: () => readonly RewindPoint[]
  /** Change feed the React binding subscribes to. */
  subscribe: (listener: () => void) => () => void
}

/** How long a failed read waits before one retry, with the view still on screen. */
const RETRY_DELAY = 2500

export function pointStore(read: () => Promise<UiReply>): PointStore {
  // The revision answering the last settle. A failed read clears it, so the
  // next mount reads again instead of serving the failure for the life of the
  // process — which is what it did while the first read could lose a race
  // against the conversation being open.
  let revision: FilesnapProjection | undefined
  let latest: FilesnapProjection | undefined
  let points: readonly RewindPoint[] = []
  let generation = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const snapshot = () => points
  const publish = (next: readonly RewindPoint[]) => {
    points = next
    for (const listener of listeners) listener()
  }
  const attempt = (ticket: number, again: boolean) => {
    const failed = () => {
      if (ticket !== generation) return
      revision = undefined
      publish([])
      if (again) schedule()
    }
    void read().then(result => {
      if (ticket !== generation) return
      if (!result.ok) { failed(); return }
      revision = latest
      publish(result.points ?? [])
    }).catch(failed)
  }
  const schedule = () => {
    if (retry !== undefined) return
    retry = setTimeout(() => {
      retry = undefined
      // A closed view retries through the cleared revision on its next open.
      if (listeners.size > 0) attempt(++generation, false)
    }, RETRY_DELAY)
  }
  const refresh = (projection: FilesnapProjection | undefined) => {
    if (projection === undefined) return
    latest = projection
    if (revision === projection) return
    revision = projection
    attempt(++generation, true)
  }
  return { refresh, snapshot, subscribe }
}
