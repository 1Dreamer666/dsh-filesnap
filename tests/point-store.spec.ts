import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RewindPoint, UiReply } from '../src/wire.ts'
import { pointStore } from '../src/client/point-store.ts'

const point: RewindPoint = { point: 's.t2', turn: 2, at: 1000, boundary: 10, label: 'prompt', messageId: 'm2' }
const projection = { points: [] }
const flush = async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve() }

it('reads once per revision and serves the settled points', async () => {
  let calls = 0
  const store = pointStore(async (): Promise<UiReply> => { calls += 1; return { ok: true, points: [point] } })
  store.refresh(projection)
  await flush()
  expect(store.snapshot()).toEqual([point])
  store.refresh(projection)
  await flush()
  expect(calls).toBe(1)
})

it('clears the revision after a failed read so the next open reads again', async () => {
  let calls = 0
  const store = pointStore(async (): Promise<UiReply> => {
    calls += 1
    return calls === 1 ? { ok: false, error: 'Open this conversation before using FileSnap.' } : { ok: true, points: [point] }
  })
  let settled = 0
  store.subscribe(() => { settled += 1 })
  store.refresh(projection)
  await flush()
  expect(settled).toBe(1)
  expect(store.snapshot()).toEqual([])
  store.refresh(projection)
  await flush()
  expect(calls).toBe(2)
  expect(store.snapshot()).toEqual([point])
})

it('retries once for a view still on screen after a failure', async () => {
  vi.useFakeTimers()
  try {
    let calls = 0
    const store = pointStore(async (): Promise<UiReply> => {
      calls += 1
      return calls === 1 ? { ok: false, error: 'not open yet' } : { ok: true, points: [point] }
    })
    store.subscribe(() => {})
    store.refresh(projection)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(store.snapshot()).toEqual([])
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toBe(2)
    expect(store.snapshot()).toEqual([point])
  } finally {
    vi.useRealTimers()
  }
})

describe('retry ownership', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not let an old retry erase points recovered by reopening the view', async () => {
    const read = vi.fn<() => Promise<UiReply>>()
      .mockResolvedValue({ ok: false, error: 'temporarily unavailable' })
      .mockResolvedValueOnce({ ok: false, error: 'not open yet' })
      .mockResolvedValueOnce({ ok: true, points: [point] })
    const store = pointStore(read)
    store.subscribe(() => {})
    store.refresh(projection)
    await flush()
    store.refresh(projection)
    await flush()
    expect(store.snapshot()).toEqual([point])

    await vi.advanceTimersByTimeAsync(3000)
    expect(store.snapshot()).toEqual([point])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps a newer revision request authoritative while it is still pending', async () => {
    const pending = Promise.withResolvers<UiReply>()
    const read = vi.fn<() => Promise<UiReply>>()
      .mockResolvedValue({ ok: false, error: 'temporarily unavailable' })
      .mockRejectedValueOnce(new Error('connection unavailable'))
      .mockReturnValueOnce(pending.promise)
    const store = pointStore(read)
    store.subscribe(() => {})
    store.refresh(projection)
    await flush()
    store.refresh({ points: [point] })

    await vi.advanceTimersByTimeAsync(3000)
    pending.resolve({ ok: true, points: [point] })
    await flush()
    expect(store.snapshot()).toEqual([point])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('shares a pending timed retry with new consumers of the same revision', async () => {
    const pending = Promise.withResolvers<UiReply>()
    const read = vi.fn<() => Promise<UiReply>>()
      .mockResolvedValue({ ok: false, error: 'temporarily unavailable' })
      .mockResolvedValueOnce({ ok: false, error: 'not open yet' })
      .mockReturnValueOnce(pending.promise)
    const store = pointStore(read)
    store.subscribe(() => {})
    store.refresh(projection)
    await vi.advanceTimersByTimeAsync(2500)
    store.refresh(projection)
    store.refresh(projection)
    pending.resolve({ ok: true, points: [point] })
    await flush()

    expect(store.snapshot()).toEqual([point])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('stops after one automatic retry but allows the next opening to try again', async () => {
    const read = vi.fn<() => Promise<UiReply>>()
      .mockResolvedValue({ ok: false, error: 'still unavailable' })
    const store = pointStore(read)
    store.subscribe(() => {})
    store.refresh(projection)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(2)

    read.mockResolvedValueOnce({ ok: true, points: [point] })
    store.refresh(projection)
    await flush()
    expect(store.snapshot()).toEqual([point])
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('does not retry a closed view and reads again when it is reopened', async () => {
    const read = vi.fn<() => Promise<UiReply>>()
      .mockResolvedValueOnce({ ok: false, error: 'not open yet' })
      .mockResolvedValue({ ok: true, points: [point] })
    const store = pointStore(read)
    const close = store.subscribe(() => {})
    store.refresh(projection)
    await flush()
    close()
    await vi.advanceTimersByTimeAsync(3000)
    expect(read).toHaveBeenCalledTimes(1)

    store.subscribe(() => {})
    store.refresh(projection)
    await flush()
    expect(store.snapshot()).toEqual([point])
    expect(read).toHaveBeenCalledTimes(2)
  })
})
