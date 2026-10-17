import { expect, it, vi } from 'vitest'
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
