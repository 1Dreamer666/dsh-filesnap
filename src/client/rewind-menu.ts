import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RewindPoint, UiReply } from '../wire.ts'

/** Decorate only bare /rewind; the host continues to own argued commands. */
export function rewindMenu(
  read: (sessionId: SessionId) => Promise<UiReply>,
  open: (sessionId: SessionId, point: RewindPoint) => void,
  turnLabel: (turn: number) => string,
): CommandDecoration {
  const signals = new WeakMap<object, AbortSignal>()
  const points = async (sessionId: SessionId) => {
    const result = await read(sessionId)
    if (!result.ok) throw new Error(result.error ?? 'Could not load rewind points.')
    return (result.points ?? []).filter(point => point.boundary !== undefined)
  }
  return {
    name: 'rewind',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: async (session, signal) => {
        signals.set(session, signal)
        const available = await points(session.sessionId)
        signal.throwIfAborted()
        return available.sort((a, b) => b.turn - a.turn).map(point => ({
          id: point.point,
          label: `${turnLabel(point.turn)}${point.label ? ` · ${point.label}` : ''}`,
          detail: new Date(point.at).toLocaleString(),
        }))
      },
      onSelect: async (option, session) => {
        const signal = signals.get(session)
        signal?.throwIfAborted()
        const target = (await points(session.sessionId)).find(point => point.point === option.id)
        signal?.throwIfAborted()
        if (target === undefined) throw new Error('This rewind point is no longer available. Reopen /rewind.')
        open(session.sessionId, target)
      },
    },
  }
}

/** Session-scoped transient selection; never stored in conversation history. */
export function rewindSelection() {
  let selection: { point: RewindPoint; sequence: number } | null = null
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => selection,
    open: (point: RewindPoint) => { selection = { point, sequence: ++sequence }; publish() },
    close: () => { selection = null; publish() },
  }
}
