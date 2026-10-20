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
  // The revision being read or answering the last settle. A failed read
  // clears it, so the next mount reads again instead of serving the failure
  // for the life of the process when the first read races the view opening.
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
  const cancelRetry = () => {
    if (retry === undefined) return
    clearTimeout(retry)
    retry = undefined
  }
  const publish = (next: readonly RewindPoint[]) => {
    points = next
    for (const listener of listeners) listener()
  }
  const attempt = (ticket: number, again: boolean) => {
    const failed = () => {
      if (ticket !== generation) return
      revision = undefined
      publish([])
      if (again) schedule(ticket)
    }
    void read().then(result => {
      if (ticket !== generation) return
      if (!result.ok) { failed(); return }
      cancelRetry()
      revision = latest
      publish(result.points ?? [])
    }).catch(failed)
  }
  const schedule = (ticket: number) => {
    if (ticket !== generation || retry !== undefined) return
    retry = setTimeout(() => {
      retry = undefined
      if (ticket !== generation) return
      // A closed view retries through the cleared revision on its next open.
      if (listeners.size === 0) return
      // New consumers must share this request while the retry is pending.
      revision = latest
      attempt(++generation, false)
    }, RETRY_DELAY)
  }
  const refresh = (projection: FilesnapProjection | undefined) => {
    if (projection === undefined) return
    latest = projection
    if (revision === projection) return
    // A new request supersedes the retry scheduled by the earlier failure.
    cancelRetry()
    revision = projection
    attempt(++generation, true)
  }
  return { refresh, snapshot, subscribe }
}
