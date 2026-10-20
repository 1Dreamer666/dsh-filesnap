import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RedoPreview } from '../wire.ts'
import type { RewindHeaderActions } from './actions.ts'
import { IconRefresh } from './icons.ts'
import css from './RewindAction.module.css'

export function RedoAction({ redoSelection: selection, onRedoPreview, onRedoConfirm, onOpenSession, t }:
  Pick<RewindHeaderActions, 'redoSelection' | 'onRedoPreview' | 'onRedoConfirm' | 'onOpenSession'> & PropsLocale<'filesnap'>) {
  const selected = useSyncExternalStore(selection.subscribe, selection.snapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const busy = useRef(false)
  const generation = useRef(0)
  const [phase, setPhase] = useState<'ready' | 'loading' | 'confirming'>('ready')
  const [preview, setPreview] = useState<RedoPreview | null>(null)
  const [noRestore, setNoRestore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ message: string; child?: string | undefined } | null>(null)
  useEffect(() => () => { generation.current++; busy.current = false; selection.close() }, [selection])
  useEffect(() => {
    if (selected === null || busy.current) return
    generation.current++
    setNoRestore(false); setPreview(selected.preview); setError(null); setResult(null); setPhase('ready')
    dialog.current?.showModal()
  }, [selected])
  const close = () => {
    if (phase === 'confirming') return
    generation.current++; busy.current = false; selection.close()
    setPreview(null); setPhase('ready'); dialog.current?.close()
  }
  const load = async () => {
    if (busy.current) return
    busy.current = true
    const attempt = ++generation.current
    setNoRestore(false); setPhase('loading'); setPreview(null); setError(null); setResult(null)
    dialog.current?.showModal()
    try {
      const reply = await onRedoPreview()
      if (attempt !== generation.current) return
      if (reply.ok && reply.redoPreview !== undefined) setPreview(reply.redoPreview)
      else if (reply.errorCode === 'no-restore') setNoRestore(true)
      else setError(reply.error ?? t('redoUnavailable'))
    } catch (failure) { if (attempt === generation.current) setError(String(failure)) }
    finally { if (attempt === generation.current) { busy.current = false; setPhase('ready') } }
  }
  const confirm = async () => {
    if (busy.current || preview === null) return
    busy.current = true
    const attempt = ++generation.current
    setPhase('confirming'); setError(null)
    try {
      const reply = await onRedoConfirm(preview.token)
      if (attempt !== generation.current) return
      setPreview(null); selection.close()
      if (reply.ok) setResult({ message: reply.message ?? t('redoDone'), child: reply.child })
      else if (reply.errorCode === 'no-restore') setNoRestore(true)
      else setError(reply.error ?? t('redoUnavailable'))
    } catch (failure) { if (attempt === generation.current) { setPreview(null); setError(String(failure)) } }
    finally { if (attempt === generation.current) { busy.current = false; setPhase('ready') } }
  }
  return <>
    <Tooltip label={t('undo')} side="bottom" delayMs={500}>
      <button type="button" className={css.action} aria-label={t('undo')} disabled={phase !== 'ready'} onClick={() => { void load() }}><IconRefresh size={14} /></button>
    </Tooltip>
    <dialog ref={dialog} className={css.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close() }}>
      <h2 id={titleId}>{t(noRestore ? 'redoNoRestore' : 'redoTitle')}</h2>
      {noRestore && <p role="status">{t('redoNoRestoreDetail')}</p>}
      {preview !== null && <p>{t('redoExplanation')}</p>}
      {phase === 'loading' && <p role="status">{t('previewLoading')}</p>}
      {preview !== null && <>
        <p>{t('previewCounts', { written: String(preview.changes.filter(change => change.action === 'write').length), deleted: String(preview.changes.filter(change => change.action === 'delete').length) })}</p>
        {preview.returnedTo !== undefined && <p>{t('redoDestination', { session: preview.returnedTo })}</p>}
        {preview.changes.length === 0 ? <p>{t('redoEmpty')}</p> : <ul className={css.changes} aria-label={t('previewFiles')}>
          {preview.changes.map(change => <li key={change.path}><strong className={change.action === 'delete' ? css.deletion : undefined}>{t(change.action === 'delete' ? 'previewDelete' : 'previewWrite')}</strong><code>{change.path}</code></li>)}
        </ul>}
        <p>{t('previewRefreshNotice')}</p>
      </>}
      {result !== null && <pre className={css.report}>{result.message}</pre>}
      {error !== null && <p className={css.failure} role="alert">{error}</p>}
      <div className={css.buttons}>
        <button type="button" disabled={phase === 'confirming'} onClick={close}>{t(result === null && !noRestore ? 'cancel' : 'close')}</button>
        {error !== null && <button type="button" disabled={phase !== 'ready'} onClick={() => { void load() }}>{t('previewRetry')}</button>}
        {result === null && !noRestore && <button type="button" disabled={preview === null || phase !== 'ready'} onClick={() => { void confirm() }}>{t(phase === 'confirming' ? 'redoWorking' : 'redoConfirm')}</button>}
        {result?.child !== undefined && <button type="button" onClick={() => { const child = result.child; close(); if (child !== undefined) onOpenSession(child) }}>{t('openOriginal')}</button>}
      </div>
    </dialog>
  </>
}
