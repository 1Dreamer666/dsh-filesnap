/** Session actions and independent result panels; no command transcript output. */
import { useCallback, useRef, useState } from 'react'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindHeaderActions, RewindActionResult } from './actions.ts'
import { SnapshotPanel } from './SnapshotPanel.tsx'
import css from './RewindAction.module.css'

/** Full props: the owner share, the injected verbs, and the locale seat. */
export type RewindHeaderProps
  = PropsRuntime<'conversation.session.header.actions'> & RewindHeaderActions & PropsLocale<'filesnap'>

/**
 * The session-level strip.
 *
 * @param props - the runtime share, the two verbs, and the locale seat.
 * @returns the status control, plus the undo control when a rewind landed here.
 */
export function RewindHeader({ onRedo, onStatus, onCleanupPreview, onCleanupConfirm, onOpenSession, t }: RewindHeaderProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [destination, setDestination] = useState<string | undefined>()
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (action: () => Promise<RewindActionResult>): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError(result.error ?? 'Operation failed.')
      else if (result.message !== undefined) { setMessage(result.message); setDestination(result.child); dialog.current?.showModal() }
    } catch (failure) { setError(String(failure)) }
    finally { pendingRef.current = false; setPending(false) }
  }, [])

  const undoLabel = t('undo')

  return (
    <>
      <>
        <Tooltip label={undoLabel} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.action}
            disabled={pending}
            aria-label={undoLabel}
            onClick={() => { void run(onRedo) }}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        </Tooltip>
      </>
      <SnapshotPanel onStatus={onStatus} onCleanupPreview={onCleanupPreview} onCleanupConfirm={onCleanupConfirm} t={t} />
      <dialog ref={dialog} className={css.dialog} aria-label={t('status')}>
        <pre className={css.report}>{message}</pre>
        <div className={css.buttons}>
          <button type="button" onClick={() => dialog.current?.close()}>{t('close')}</button>
          {destination !== undefined && <button type="button" onClick={() => { dialog.current?.close(); onOpenSession(destination) }}>{t('openOriginal')}</button>}
        </div>
      </dialog>
      {error !== null && <span className={css.failure} role="alert">{error}</span>}
    </>
  )
}
