import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { revealSession } from '../src/client/open-session.ts'

const id = 'session-aaaa' as SessionId

/** A client context with only the lookup and logging the helper performs. */
function host(workspace: unknown, warn = vi.fn()) {
  return {
    get: (name: string) => name === 'uiWorkspace' ? workspace : undefined,
    logger: { warn },
  }
}

it('reveals through uiWorkspace when the client has one', () => {
  const open = vi.fn()
  const legacy = vi.fn()
  expect(revealSession(host({ openSession: open }), { open: legacy }, id)).toBe(true)
  expect(open.mock.calls).toEqual([[id]])
  expect(legacy).not.toHaveBeenCalled()
})

it('falls back to the controller open() older clients carry', () => {
  const legacy = vi.fn()
  expect(revealSession(host(undefined), { open: legacy }, id)).toBe(true)
  expect(legacy.mock.calls).toEqual([[id]])
})

it('treats a workspace without openSession as absent', () => {
  const legacy = vi.fn()
  expect(revealSession(host({}), { open: legacy }, id)).toBe(true)
  expect(legacy.mock.calls).toEqual([[id]])
})

it('swallows a client with no navigation API at all', () => {
  expect(revealSession(host(undefined), {}, id)).toBe(false)
})

it('warns and still tries the controller when the workspace refuses', () => {
  const warn = vi.fn()
  const legacy = vi.fn()
  const refusing = () => { throw new Error('released') }
  expect(revealSession(host({ openSession: refusing }, warn), { open: legacy }, id)).toBe(true)
  expect(warn).toHaveBeenCalledOnce()
  expect(legacy.mock.calls).toEqual([[id]])
})
