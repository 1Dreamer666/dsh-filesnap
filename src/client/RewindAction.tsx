/**
 * The rewind control, one per turn, in the assistant message's own icon row.
 *
 * A message with no point renders nothing. Only the assistant message that
 * closed a turn carries one, so the control appears once per turn — under the
 * last bubble of that turn, which is where "undo this" belongs.
 *
 * @module
 */

import { useEffect, useId, useRef, useState } from 'react'
import { IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindPoint, RewindPreview } from '../wire.ts'
import type { RewindActions } from './actions.ts'
import css from './RewindAction.module.css'

/** Full props: the owner's message identity, the injected verb, and the locale seat. */
export type RewindActionProps
  = PropsRuntime<'conversation.chat.assistant-actions'> & RewindActions & PropsLocale<'filesnap'>

/**
 * What this turn's snapshot covered, as one line for the tooltip.
 *
 * `reused + hashed` is the file count: every tracked file is one or the other.
 * The split is still worth showing, because a turn that hashed hundreds of
 * files is doing something a turn that reused them is not.
 *
 * @param point - the point under this message.
 * @param t - the locale seat.
 * @returns the summary line, or undefined when the capture predates coverage reporting.
 */
function coverageLine(point: RewindPoint, t: RewindActionProps['t']): string | undefined {
  const coverage = point.coverage
  if (coverage === undefined) return undefined
  const tracked = coverage.reused + coverage.hashed
  const base = t('covered', { tracked: String(tracked), hashed: String(coverage.hashed) })
  return coverage.dropped === 0 ? base : `${base} · ${t('dropped', { dropped: String(coverage.dropped) })}`
}

/**
 * One message's rewind control.
 *
 * @param props - the message identity, the rewind verb, the projection seat, and the locale seat.
 * @returns the icon button, or nothing when this message closes no captured turn.
 */
export function RewindAction({ messageId, onPreview, onRewind, usePoints, useProjection, t }: RewindActionProps) {
  const points = usePoints(useProjection('filesnap'))
  const point = points.find(candidate => candidate.messageId === messageId)
  return point === undefined ? null : <RewindControl point={point} onPreview={onPreview} onRewind={onRewind} t={t} />
}

/** Shared preview/confirmation flow for message buttons and the slash menu. */
export function RewindControl({ point, onPreview, onRewind, t, autoOpen = false, onClose }: {
  point: RewindPoint
  onPreview: RewindActions['onPreview']
  onRewind: RewindActions['onRewind']
  t: RewindActionProps['t']
  autoOpen?: boolean
  onClose?: () => void
}) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'confirming'>('idle')
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => () => { generation.current++; busy.current = false }, [])

  const close = () => {
    if (phase === 'confirming') return
    generation.current++
    busy.current = false
    setPhase('idle')
    setPreview(null)
    dialog.current?.close()
    onClose?.()
  }

  const load = async (target: RewindPoint) => {
    if (busy.current) return
    busy.current = true
    const attempt = ++generation.current
    setPhase('loading')
    setPreview(null)
    setFailure(null)
    dialog.current?.showModal()
    try {
      const result = await onPreview(target)
      if (attempt !== generation.current) return
      if (result.ok && result.preview !== undefined && result.preview.point === target.point) setPreview(result.preview)
      else setFailure(result.error ?? t('previewUnavailable'))
    } catch (error) {
      if (attempt === generation.current) setFailure(String(error))
    } finally {
      if (attempt === generation.current) { busy.current = false; setPhase('ready') }
    }
  }

  const confirm = async (target: RewindPoint) => {
    if (busy.current || preview === null) return
    busy.current = true
    const attempt = generation.current
    setPhase('confirming')
    setFailure(null)
    try {
      const result = await onRewind(target, preview.token)
      if (attempt !== generation.current) return
      setPreview(null) // A token is single-use, including failed confirmations.
      if (result.ok) { dialog.current?.close(); onClose?.() }
      else setFailure(result.error ?? t('previewUnavailable'))
    } catch (error) {
      if (attempt === generation.current) { setPreview(null); setFailure(String(error)) }
    } finally {
      if (attempt === generation.current) { busy.current = false; setPhase('ready') }
    }
  }

  // Menu controls mount once per selection, with a fixed target and callbacks.
  useEffect(() => { if (autoOpen) void load(point) }, [])

  const covered = coverageLine(point, t)
  const label = point.label === undefined ? t('rewindHere') : t('rewindTo', { label: point.label })
  return (
    <>
      {!autoOpen && <Tooltip label={covered === undefined ? label : `${label}\n${covered}`} side="bottom" delayMs={500}>
        <button type="button" className={css.action} disabled={phase === 'loading' || phase === 'confirming'}
          aria-label={label} onClick={() => { void load(point) }}>
          <IconRefreshOutline16 size={14} />
        </button>
      </Tooltip>}
      <dialog ref={dialog} className={css.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
        onCancel={event => { event.preventDefault(); close() }}>
        <h2 id={titleId}>{t('previewTitle', { turn: String(point.turn) })}</h2>
        <p>{label}</p>
        <p id={descriptionId}>{t('previewExplanation')}</p>
        {phase === 'loading' && <p role="status">{t('previewLoading')}</p>}
        {preview !== null && <>
          <p>{t('previewCounts', {
            written: String(preview.changes.filter(change => change.action === 'write').length),
            deleted: String(preview.changes.filter(change => change.action === 'delete').length),
          })}</p>
          {preview.changes.length === 0 ? <p>{t('previewEmpty')}</p> :
            <ul className={css.changes} aria-label={t('previewFiles')}>
              {preview.changes.map(change => <li key={change.path}>
                <strong className={change.action === 'delete' ? css.deletion : undefined}>
                  {t(change.action === 'delete' ? 'previewDelete' : 'previewWrite')}
                </strong>
                <code>{change.path}</code>
              </li>)}
            </ul>}
          <p>{t('previewRefreshNotice')}</p>
        </>}
        {failure !== null && <p className={css.failure} role="alert">{t('failed', { reason: failure })}</p>}
        <div className={css.buttons}>
          <button type="button" disabled={phase === 'confirming'} onClick={close}>{t('cancel')}</button>
          {failure !== null && <button type="button" disabled={phase !== 'ready'} onClick={() => { void load(point) }}>{t('previewRetry')}</button>}
          <button type="button" disabled={preview === null || phase !== 'ready'} onClick={() => { void confirm(point) }}>
            {t(phase === 'confirming' ? 'rewinding' : 'confirmRewind')}
          </button>
        </div>
      </dialog>
    </>
  )
}
