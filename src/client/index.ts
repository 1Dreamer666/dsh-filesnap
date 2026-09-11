/** Browser controls use authenticated Connection RPC; only native turn anchors use a projection. */
// Taken from cordis and the session package rather than from
// `@deepseek-ai/dsh-client-runtime/client`, which the harness has since
// removed. That package's `ClientContext` was `export type ClientContext =
// Context` — a plain alias — so this is the same type from its own home, and it
// resolves against a harness from either side of the removal.
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ui-chat SlotMap merge (the per-message action row).
// Separate from ui-conversation since the harness split the chat surface out.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-conversation SlotMap merge (the session header strip).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `filesnap` SessionProjectionMap key merge, from the pure-type
// outlet — importing the host's projection module here would merge the host's
// `sessions` (a `SessionStore`) over the browser's, which is the
// session-controller's `ISessions` and the only one with `fork` and `open`.
import type { RewindPoint } from '../wire.ts'
import type { RewindActionResult, RewindActions, RewindHeaderActions } from './actions.ts'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { redoMenu, redoSelection } from './redo-menu.ts'
import { rewindMenu, rewindSelection } from './rewind-menu.ts'
import { CommandRewindPreview, type CommandRewindActions } from './CommandRewindPreview.tsx'
import { RewindAction } from './RewindAction.tsx'
import { RewindHeader } from './RewindHeader.tsx'
import { en, zh, type RewindKey } from './locales.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { UiReply } from '../wire.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { MigrationPanel, type MigrationActions } from './MigrationPanel.tsx'
import { pointReader } from './points.ts'
import { refillPrompt } from './refill.ts'

export { RewindAction } from './RewindAction.tsx'
export { RewindHeader } from './RewindHeader.tsx'
export type { RewindActionResult, RewindActions, RewindHeaderActions } from './actions.ts'
export type { RewindKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The rewind controls' copy. */
    filesnap: RewindKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'filesnap'

/** Required services: the slot system, session control, and copy. */
export const inject = ['slots', 'sessions', 'locale', 'conversation', 'connection', 'commandUi']

/**
 * Client plugin body: the per-turn rewind control and the session-level strip.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-filesnap: dictionaries')

  const sessions = ctx.sessions

  const connection = ctx.get('connection') as ConnectionHandle
  const readers = new Map<string, ReturnType<typeof pointReader>>()
  const request = async (sessionId: SessionId, endpoint: string, args: object = {}): Promise<UiReply> => {
    try {
      const result = await connection.rpc.call('/filesnap', endpoint, { sessionId, ...args })
      if (!result.ok) return { ok: false, error: result.error.message }
      const reply = result.value as UiReply
      return typeof reply?.ok === 'boolean' ? reply : { ok: false, error: 'Invalid FileSnap response.' }
    } catch (error) { return { ok: false, error: String(error) } }
  }
  const reader = (sessionId: SessionId) => {
    let usePoints = readers.get(sessionId)
    if (usePoints === undefined) { usePoints = pointReader(() => request(sessionId, 'points')); readers.set(sessionId, usePoints) }
    return usePoints
  }
  ctx.effect(() => () => { readers.clear() })

  const maintenance = async <T,>(endpoint: string, payload: object): Promise<T> => {
    const result = await connection.rpc.call('/filesnap', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    const refusal = result.value as { ok?: boolean; error?: string } | null
    if (refusal?.ok === false) throw new Error(refusal.error ?? 'Migration failed.')
    return result.value as T
  }
  const migrationActions: MigrationActions = {
    automaticStatus: () => maintenance('migration-auto-status', {}),
    list: () => maintenance('migration-list', {}),
    scan: task => maintenance('migration-scan', { task }),
    migrate: token => maintenance('migration-apply', { token }),
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'filesnap', order: 60, label: 'FileSnap', locale: NS,
    inject: () => migrationActions,
  }, MigrationPanel))

  const actions = (sessionId: SessionId): RewindActions => ({
    usePoints: reader(sessionId),
    onPreview: point => request(sessionId, 'preview', { point: point.point }),
    onRewind: async (point: RewindPoint, token: string): Promise<RewindActionResult> => {
      // An omitted `atSeq` does not mean "cut at the beginning" — the host
      // reads it as "the last completed turn", which would fork the newest
      // state and then restore old files into it. A point with no anchor
      // renders no control, so this is unreachable; it is checked anyway
      // because the failure it prevents is silent and looks like success.
      const atSeq = point.boundary
      if (atSeq === undefined) {
        return { ok: false, error: `turn ${String(point.turn)} has no completed turn before it to fork from` }
      }
      // The fork first, because the host files the undo record in the
      // session named by `--into` and that has to exist before it is named.
      let child: SessionId
      try {
        child = await sessions.fork({ sessionId, atSeq, increaseTitle: true })
      } catch (error: unknown) {
        return { ok: false, error: String(error) }
      }
      const done = await request(sessionId, 'rewind', { point: point.point, child, token })
      if (done.ok && done.message !== undefined) return { ok: false, error: done.message }
      if (done.ok) {
        sessions.open(child)
        const binding = sessions.binding(child)
        if (binding !== undefined) {
          try { refillPrompt(ctx.conversation.input.for(binding.ctx), done.promptText) }
          catch (error) { ctx.logger.warn('filesnap: could not refill the prompt: %s', String(error)) }
        }
      }
      return done
    },
  })
  const selections = new Map<SessionId, ReturnType<typeof rewindSelection>>()
  const selectionFor = (sessionId: SessionId) => {
    let selection = selections.get(sessionId)
    if (selection === undefined) { selection = rewindSelection(); selections.set(sessionId, selection) }
    return selection
  }
  ctx.effect(() => () => { selections.clear() })
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.commandUi.decorate(rewindMenu(
    sessionId => request(sessionId, 'points'),
    (sessionId, point) => selectionFor(sessionId).open(point),
    turn => t('menuTurn', { turn: String(turn) }),
  )), 'filesnap: /rewind picker')

  const redoSelections = new Map<SessionId, ReturnType<typeof redoSelection>>()
  const redoSelectionFor = (sessionId: SessionId) => {
    let selection = redoSelections.get(sessionId)
    if (selection === undefined) { selection = redoSelection(); redoSelections.set(sessionId, selection) }
    return selection
  }
  ctx.effect(() => () => { redoSelections.clear() })
  ctx.effect(() => ctx.commandUi.decorate(redoMenu(
    sessionId => request(sessionId, 'redo-preview'),
    (sessionId, preview) => redoSelectionFor(sessionId).open(preview),
    () => t('redoMenu'),
  )), 'filesnap: /redo confirmation')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'filesnap-command-preview', order: 21, locale: NS,
    inject: (sessionId): CommandRewindActions => ({ selection: selectionFor(sessionId), ...actions(sessionId) }),
  }, CommandRewindPreview))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'filesnap',
    // After feedback (10), so the destructive control is not the one a stray
    // click lands on.
    order: 30,
    locale: NS,
    inject: actions,
  }, RewindAction))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'filesnap',
    order: 20,
    locale: NS,
    inject: (sessionId): RewindHeaderActions => ({
      onOpenSession: id => sessions.open(id as SessionId),
      onCleanupPreview: () => request(sessionId, 'cleanup-preview'),
      onCleanupConfirm: token => request(sessionId, 'cleanup', { token }),
      redoSelection: redoSelectionFor(sessionId),
      onRedoPreview: () => request(sessionId, 'redo-preview'),
      onRedoConfirm: token => request(sessionId, 'redo', { token }),
      onStatus: () => request(sessionId, 'status'),
    }),
  }, RewindHeader))
}
