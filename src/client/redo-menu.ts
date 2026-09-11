import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RedoPreview, UiReply } from '../wire.ts'

/** A bare /redo selects a prepared restore; applying it belongs to the dialog. */
export function redoMenu(read: (session: SessionId) => Promise<UiReply>, open: (session: SessionId, preview: RedoPreview) => void, label: () => string): CommandDecoration {
  const previews = new WeakMap<object, { preview: RedoPreview; signal: AbortSignal }>()
  return { name: 'redo', available: () => true, ui: {
    kind: 'popupSelect',
    options: async (session, signal) => {
      const reply = await read(session.sessionId)
      signal.throwIfAborted()
      if (!reply.ok || reply.redoPreview === undefined) throw new Error(reply.error ?? 'Could not preview redo.')
      previews.set(session, { preview: reply.redoPreview, signal })
      return [{ id: reply.redoPreview.token, label: label() }]
    },
    onSelect: (option, session) => {
      const saved = previews.get(session)
      if (saved === undefined || saved.preview.token !== option.id) throw new Error('Reopen /redo to preview again.')
      saved.signal.throwIfAborted()
      open(session.sessionId, saved.preview)
    },
  } }
}

export function redoSelection() {
  let value: { preview: RedoPreview; sequence: number } | null = null
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => value,
    open: (preview: RedoPreview) => { value = { preview, sequence: ++sequence }; publish() },
    close: () => { value = null; publish() },
  }
}
