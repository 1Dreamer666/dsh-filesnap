import { expect, it, vi } from 'vitest'
import type { RefillState } from '../src/client/refill.ts'
import { refillPrompt } from '../src/client/refill.ts'

/** One composer-state row: only an empty, idle, plain composer may take the prompt. */
const rows: Array<{ name: string; state: RefillState; fills: boolean }> = [
  { name: 'older imageIds state', state: { draft: '', imageIds: [], phase: 'plain' }, fills: true },
  { name: 'current attachmentIds state', state: { draft: '', attachmentIds: [], phase: 'plain' }, fills: true },
  { name: 'no attachment list at all', state: { draft: '', phase: 'plain' }, fills: true },
  { name: 'a written draft', state: { draft: 'my draft', imageIds: [], phase: 'plain' }, fills: false },
  { name: 'images under the older name', state: { draft: '', imageIds: ['image'], phase: 'plain' }, fills: false },
  { name: 'attachments under the current name', state: { draft: '', attachmentIds: ['file'], phase: 'plain' }, fills: false },
  { name: 'a busy phase', state: { draft: '', imageIds: [], phase: 'editing' }, fills: false },
]

it('refills only an empty plain composer and never replaces drafts or attachments', () => {
  for (const { name, state, fills } of rows) {
    const setDraft = vi.fn()
    expect(refillPrompt({ state: { getSnapshot: () => state }, setDraft }, '完整提示\n第二行'), name).toBe(fills)
    expect(setDraft.mock.calls, name).toEqual(fills ? [['完整提示\n第二行']] : [])
  }
})

it('refuses an absent or empty prompt', () => {
  const setDraft = vi.fn()
  const input = { state: { getSnapshot: (): RefillState => ({ draft: '', imageIds: [], phase: 'plain' }) }, setDraft }
  expect(refillPrompt(input, undefined)).toBe(false)
  expect(refillPrompt(input, '')).toBe(false)
  expect(setDraft).not.toHaveBeenCalled()
})
