import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { redoMenu, redoSelection } from '../src/client/redo-menu.ts'

it('opens only a preview, propagates unavailable undo, and ignores cancelled selections', async () => {
  const preview = { token: 'token', changes: [{ path: '/a', action: 'write' as const }] }
  const open = vi.fn()
  const session = { sessionId: SessionId('s') }
  const abort = new AbortController()
  const menu = redoMenu(async () => ({ ok: true, redoPreview: preview }), open, () => 'Review redo')
  const options = await menu.ui.options(session, abort.signal)
  expect(open).not.toHaveBeenCalled()
  await menu.ui.onSelect(options[0]!, session)
  expect(open).toHaveBeenCalledExactlyOnceWith(session.sessionId, preview)
  abort.abort()
  expect(() => menu.ui.onSelect(options[0]!, session)).toThrow()
  const missing = redoMenu(async () => ({ ok: false, error: 'No undo record' }), open, String)
  await expect(missing.ui.options(session, new AbortController().signal)).rejects.toThrow('No undo record')
  const a = redoSelection(), b = redoSelection()
  a.open(preview)
  expect(b.snapshot()).toBeNull()
  a.close()
  expect(a.snapshot()).toBeNull()
})
