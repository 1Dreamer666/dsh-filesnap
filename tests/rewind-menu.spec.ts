import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { rewindMenu, rewindSelection } from '../src/client/rewind-menu.ts'
import type { RewindPoint, UiReply } from '../src/wire.ts'

const session = { sessionId: SessionId('source') }
const point = (turn: number): RewindPoint => ({ point: `source.t${turn}`, turn, at: 0, boundary: turn * 10, label: `Prompt ${turn}` })

it('lists newest restorable turns first and opens only the selected preview in its source session', async () => {
  const first = { point: 'source.t1', turn: 1, at: 0 }
  const read = vi.fn(async (): Promise<UiReply> => ({ ok: true, points: [first, point(2), point(3)] }))
  const open = vi.fn()
  const menu = rewindMenu(read, open, turn => `Before turn ${turn}`)
  const options = await menu.ui.options(session, new AbortController().signal)
  expect(options.map(option => option.id)).toEqual(['source.t3', 'source.t2'])
  expect(options[0]?.label).toContain('Prompt 3')
  expect(open).not.toHaveBeenCalled()
  await menu.ui.onSelect(options[1]!, session)
  expect(open).toHaveBeenCalledExactlyOnceWith(session.sessionId, point(2))
  expect(read).toHaveBeenLastCalledWith(session.sessionId)
})

it('shows errors, rejects missing targets and discards cancelled menu loads', async () => {
  const open = vi.fn()
  const read = vi.fn(async (): Promise<UiReply> => ({ ok: false, error: 'Store offline' }))
  const menu = rewindMenu(read, open, String)
  await expect(menu.ui.options(session, new AbortController().signal)).rejects.toThrow('Store offline')
  read.mockResolvedValue({ ok: true, points: [] })
  expect(await menu.ui.options(session, new AbortController().signal)).toEqual([])
  await expect(menu.ui.onSelect({ id: 'source.t2', label: 'Missing' }, session)).rejects.toThrow('no longer available')
  const abort = new AbortController()
  const pending = menu.ui.options(session, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
})

it('keeps selections separate between conversations and permits reopening a cancelled target', () => {
  const a = rewindSelection()
  const b = rewindSelection()
  const changed = vi.fn()
  const dispose = a.subscribe(changed)
  a.open(point(2))
  const first = a.snapshot()
  expect(b.snapshot()).toBeNull()
  a.close()
  expect(a.snapshot()).toBeNull()
  a.open(point(2))
  expect(a.snapshot()?.sequence).not.toBe(first?.sequence)
  expect(changed).toHaveBeenCalledTimes(3)
  dispose()
  a.close()
  expect(changed).toHaveBeenCalledTimes(3)
})

it('does not open a late preview after the native picker was dismissed during selection', async () => {
  const open = vi.fn()
  let finish!: (reply: UiReply) => void
  const read = vi.fn(async (): Promise<UiReply> => ({ ok: true, points: [point(2)] }))
  const menu = rewindMenu(read, open, String)
  const abort = new AbortController()
  const options = await menu.ui.options(session, abort.signal)
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = menu.ui.onSelect(options[0]!, session)
  abort.abort()
  finish({ ok: true, points: [point(2)] })
  await expect(pending).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
})
