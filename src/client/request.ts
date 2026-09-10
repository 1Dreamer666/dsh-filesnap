import type { FilesnapProjection, RewindReply } from '../wire.ts'

/** Subscribe before dispatch: RPC admission alone does not mean a command succeeded. */
export function requestReply(
  face: { getSnapshot(): unknown; subscribe(fn: () => void): () => void },
  requestId: string,
  dispatch: () => Promise<{ ok: boolean; error?: string }>,
  timeoutMs = 130_000,
): Promise<RewindReply> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = (reply: RewindReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(reply)
    }
    const timer = setTimeout(() => finish({ requestId, error: 'Timed out waiting for the rewind result. Check the conversation before retrying.' }), timeoutMs)
    const check = () => {
      const reply = (face.getSnapshot() as FilesnapProjection | undefined)?.lastReply
      if (reply?.requestId === requestId) finish(reply)
    }
    unsubscribe = face.subscribe(check)
    check()
    if (settled) { unsubscribe(); return }
    void dispatch().then(result => {
      if (!result.ok) finish({ requestId, error: result.error ?? 'Command failed.' })
      else check()
    }).catch(error => finish({ requestId, error: String(error) }))
  })
}
