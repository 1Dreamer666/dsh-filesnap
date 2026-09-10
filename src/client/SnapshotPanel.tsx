import { useEffect, useId, useRef, useState } from 'react'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FilesnapStatus } from '../wire.ts'
import type { RewindHeaderActions } from './actions.ts'
import { CleanupAction } from './CleanupAction.tsx'
import css from './RewindAction.module.css'

type Props = PropsLocale<'filesnap'> & Pick<RewindHeaderActions, 'onStatus' | 'onCleanupPreview' | 'onCleanupConfirm'>
export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** Workspace storage UI. All data is transient and fetched outside the conversation. */
export function SnapshotPanel({ onStatus, onCleanupPreview, onCleanupConfirm, t }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const generation = useRef(0)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<FilesnapStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = useId()
  useEffect(() => () => { generation.current++ }, [])
  const load = async () => {
    if (busy.current) return
    busy.current = true
    const ticket = ++generation.current
    setPending(true)
    setError(null)
    try {
      const result = await onStatus()
      if (ticket !== generation.current) return
      if (!result.ok || result.status === undefined) setError(result.error ?? t('previewUnavailable'))
      else setStatus(result.status)
    } catch (failure) { if (ticket === generation.current) setError(String(failure)) }
    finally { if (ticket === generation.current) { busy.current = false; setPending(false) } }
  }
  const close = () => { generation.current++; busy.current = false; setPending(false); dialog.current?.close() }
  return <>
    <Tooltip label={t('status')} side="bottom" delayMs={500}>
      <button className={css.action} type="button" aria-label={t('status')} onClick={() => { dialog.current?.showModal(); void load() }}>
        <IconDataOutline16 size={14} />
      </button>
    </Tooltip>
    <dialog ref={dialog} className={css.dialog} aria-labelledby={title} onCancel={close}>
      <h2 id={title}>{t('snapshotTitle')}</h2>
      {pending && <p role="status">{t('snapshotLoading')}</p>}
      {error !== null && <p role="alert" className={css.failure}>{error}</p>}
      {status !== null && <>
        <p className={css.path}>{status.workspace}</p>
        <dl className={css.metrics}>
          <div><dt>{t('workspaceRecords')}</dt><dd>{formatBytes(status.recordsBytes)}</dd></div>
          <div><dt>{t('sharedContent')}</dt><dd>{formatBytes(status.sharedContentBytes)}</dd></div>
        </dl>
        <p className={css.muted}>{t('sharedExplanation')}</p>
        <h3>{t('snapshotSessions')}</h3>
        {status.sessions.length === 0 ? <p>{t('snapshotNoSessions')}</p> : <ul className={css.sessions}>
          {status.sessions.map(session => <li key={session.session}>
            <code>{session.session}</code>
            <span>{t('snapshotTurns', { count: String(session.turns) })}</span>
          </li>)}
        </ul>}
        <details className={css.exclusions}>
          <summary>{t('snapshotExcluded', { count: String(status.unprotected.length) })}</summary>
          <ul className={css.changes}>{status.unprotected.map(file => <li key={file.path}><code>{file.path}</code><span>{file.reason}</span></li>)}</ul>
        </details>
        <section className={css.cleanupSection}>
          <h3>{t('cleanup')}</h3><p>{t('cleanupKeeps')}</p>
          <CleanupAction onCleanupPreview={onCleanupPreview} onCleanupConfirm={onCleanupConfirm} onComplete={() => { void load() }} t={t} />
        </section>
      </>}
      <div className={css.buttons}>
        <button type="button" disabled={pending} onClick={() => { void load() }}>{t('snapshotRefresh')}</button>
        <button type="button" onClick={close}>{t('close')}</button>
      </div>
    </dialog>
  </>
}
