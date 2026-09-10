import { describe, expect, it, vi } from 'vitest'
import { requestReply } from '../src/client/request.ts'
import type { FilesnapProjection, RewindReply } from '../src/wire.ts'

function fixture() {
  let snapshot: FilesnapProjection = { points: [] }
  const listeners = new Set<() => void>()
  return {
    listeners,
    face: { getSnapshot: () => snapshot, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } } },
    emit(reply: RewindReply) { snapshot = { points: [], lastReply: reply }; for (const fn of listeners) fn() },
  }
}

describe('browser command results', () => {
  it('waits beyond admission and ignores replies for other requests', async () => {
    const f = fixture()
    const settled = vi.fn()
    const result = requestReply(f.face, 'mine', async () => ({ ok: true })).then(settled)
    f.emit({ requestId: 'other', child: 'wrong' })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    f.emit({ requestId: 'mine', error: 'Files changed; preview again.' })
    await result
    expect(settled).toHaveBeenCalledWith({ requestId: 'mine', error: 'Files changed; preview again.' })
    expect(f.listeners.size).toBe(0)
  })

  it('receives a response emitted during dispatch and unsubscribes', async () => {
    const f = fixture()
    const result = await requestReply(f.face, 'mine', async () => {
      f.emit({ requestId: 'mine', child: 'child' })
      return { ok: true }
    })
    expect(result.child).toBe('child')
    expect(f.listeners.size).toBe(0)
  })

  it('cleans up after transport failure and timeout', async () => {
    const f = fixture()
    expect((await requestReply(f.face, 'mine', async () => { throw new Error('offline') })).error).toContain('offline')
    expect(f.listeners.size).toBe(0)
    expect((await requestReply(f.face, 'mine', async () => ({ ok: true }), 1)).error).toContain('Timed out')
    expect(f.listeners.size).toBe(0)
  })
})
