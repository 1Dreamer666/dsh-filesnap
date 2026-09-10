import { useEffect, useId, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CleanupPreview, CleanupOutcome } from '../wire.ts'
import type { RewindHeaderActions } from './actions.ts'
import css from './RewindAction.module.css'

type Props = PropsLocale<'filesnap'> & Pick<RewindHeaderActions, 'onCleanupPreview' | 'onCleanupConfirm'> & { onComplete?: () => void }

function bytes(value: number): string {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`
}

/** Explicit store-wide collection, with usage and protection boundaries visible before confirmation. */
export function CleanupAction({ onCleanupPreview, onCleanupConfirm, onComplete, t }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const busy = useRef(false)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [result, setResult] = useState<CleanupOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const run = async (confirm: boolean) => {
    if (busy.current || (confirm && preview === null)) return
    busy.current = true
    const ticket = ++generation.current
    setPending(true)
    setError(null)
    setResult(null)
    if (!confirm) { setPreview(null); dialog.current?.showModal() }
    try {
      const outcome = confirm ? await onCleanupConfirm(preview!.token) : await onCleanupPreview()
      if (ticket !== generation.current) return
      if (!outcome.ok) { setPreview(null); setError(outcome.error ?? t('previewUnavailable')) }
      else if (confirm && outcome.cleaned !== undefined) { setPreview(null); setResult(outcome.cleaned); onComplete?.() }
      else if (!confirm && outcome.cleanup !== undefined) setPreview(outcome.cleanup)
      else { setPreview(null); setError(t('previewUnavailable')) }
    } catch (failure) {
      if (ticket !== generation.current) return
      setPreview(null)
      setError(String(failure))
    } finally { if (ticket === generation.current) { busy.current = false; setPending(false) } }
  }

  return <>
    <button type="button" className={css.action} disabled={pending} onClick={() => { void run(false) }}>{t('cleanup')}</button>
    <dialog ref={dialog} className={css.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { if (pending) event.preventDefault() }}>
      <h2 id={titleId}>{t('cleanup')}</h2>
      <p id={descriptionId}>{t('cleanupScope')}</p>
      <p>{t('cleanupKeeps')}</p>
      {preview !== null && <>
        <p className={css.path}>{preview.workspace}</p>
        <p>{t('cleanupUsage', { records: bytes(preview.recordsBytes), shared: bytes(preview.sharedContentBytes) })}</p>
        <p>{t('cleanupEstimate')}</p>
      </>}
      {pending && <p role="status">{t('cleanupWorking')}</p>}
      {result !== null && <p role="status">{t('cleanupDone', { manifests: String(result.manifestsRemoved), blobs: String(result.blobsRemoved) })}</p>}
      {error !== null && <p className={css.failure} role="alert">{error}</p>}
      <div className={css.buttons}>
        <button type="button" disabled={pending} onClick={() => dialog.current?.close()}>{t(result === null ? 'cancel' : 'close')}</button>
        {error !== null && <button type="button" disabled={pending} onClick={() => { void run(false) }}>{t('previewRetry')}</button>}
        {result === null && <button type="button" disabled={pending || preview === null} onClick={() => { void run(true) }}>{t('cleanupConfirm')}</button>}
      </div>
    </dialog>
  </>
}
