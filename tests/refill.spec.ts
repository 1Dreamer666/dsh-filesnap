import { expect, it, vi } from 'vitest'
import { refillPrompt } from '../src/client/refill.ts'
it('refills only an empty plain composer and never replaces drafts or images', () => {
  for (const state of [
    { draft: '', imageIds: [], phase: 'plain' },
    { draft: 'my draft', imageIds: [], phase: 'plain' },
    { draft: '', imageIds: ['image'], phase: 'plain' },
    { draft: '', imageIds: [], phase: 'editing' },
  ]) {
    const setDraft = vi.fn()
    refillPrompt({ state: { getSnapshot: () => state }, setDraft }, '完整提示\n第二行')
    expect(setDraft.mock.calls).toEqual(state.draft === '' && state.imageIds.length === 0 && state.phase === 'plain' ? [['完整提示\n第二行']] : [])
  }
})
