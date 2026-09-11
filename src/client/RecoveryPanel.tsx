import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RecoveryItem, RecoveryPreview } from '../wire.ts'
import { MigrationPanel, type MigrationActions } from './MigrationPanel.tsx'
import css from './RewindAction.module.css'

export interface RecoveryActions {
  listRecovery: () => Promise<RecoveryItem[]>
  previewRecovery: (id: string, mode: 'apply' | 'rollback') => Promise<RecoveryPreview>
  applyRecovery: (token: string) => Promise<{ openSession: string }>
  openSession: (id: string) => void
}
export function FileSnapSettings(props: RecoveryActions & MigrationActions & PropsLocale<'filesnap'>) {
  return <><RecoveryPanel {...props} /><MigrationPanel {...props} /></>
}

/** Recovery stays outside the conversation, including when the source session is cold. */
export function RecoveryPanel({ listRecovery, previewRecovery, applyRecovery, openSession, t }: RecoveryActions & PropsLocale<'filesnap'>) {
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [preview, setPreview] = useState<RecoveryPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [destination, setDestination] = useState<string | null>(null)
  const busy = useRef(false), generation = useRef(0)
  useEffect(() => {
    const ticket = ++generation.current
    void listRecovery().then(rows => { if (ticket === generation.current) setItems(rows) }).catch(e => { if (ticket === generation.current) setError(String(e)) })
    return () => { generation.current++ }
  }, [listRecovery])
  const run = async (task: () => Promise<void>) => {
    if (busy.current) return
    busy.current = true; setPending(true); setError(null)
    const ticket = generation.current
    try { await task() } catch (e) { if (ticket === generation.current) { setError(String(e)); setPreview(null) } }
    finally { busy.current = false; if (ticket === generation.current) setPending(false) }
  }
  return <section className={css.settings}>
    <h2>{t('recoveryTitle')}</h2><p>{t('recoveryIntro')}</p>
    {pending && <p role="status">{t('recoveryWorking')}</p>}
    {error !== null && <p role="alert" className={css.failure}>{error}</p>}
    {items.length === 0 && <p role="status">{t('recoveryEmpty')}</p>}
    {items.map(item => <article key={item.id} className={css.recoveryItem}>
      <strong>{t(item.kind === 'rewind' ? 'recoveryRewind' : 'recoveryRedo')}</strong>
      <p className={css.path}>{item.cwd}</p>
      <p className={css.muted}>{new Date(item.createdAt).toLocaleString()} · {item.source} → {item.destination}</p>
      <div className={css.buttons}>
        <button type="button" disabled={pending || item.phase === 'rollback'} onClick={() => { void run(async () => { setPreview(null); setPreview(await previewRecovery(item.id, 'apply')) }) }}>{t('recoveryResume')}</button>
        <button type="button" disabled={pending} onClick={() => { void run(async () => { setPreview(null); setPreview(await previewRecovery(item.id, 'rollback')) }) }}>{t('recoveryRollback')}</button>
      </div>
    </article>)}
    {preview !== null && <section className={css.cleanupSection}>
      <h3>{t(preview.mode === 'apply' ? 'recoveryResume' : 'recoveryRollback')}</h3>
      <p>{t('recoveryConfirmIntro')}</p>
      <ul className={css.changes}>{preview.changes.map(row => <li key={row.path}><strong>{t(row.action === 'write' ? 'recoveryWrite' : 'recoveryDelete')}</strong><code>{row.path}</code></li>)}</ul>
      {preview.changes.length === 0 && <p>{t('recoveryNoChanges')}</p>}
      {preview.conflicts.length > 0 && <div role="alert"><p>{t('recoveryConflicts')}</p><ul>{preview.conflicts.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>}
      <div className={css.buttons}>
        <button type="button" disabled={pending} onClick={() => setPreview(null)}>{t('cancel')}</button>
        <button type="button" disabled={pending || preview.conflicts.length > 0} onClick={() => { void run(async () => {
          const result = await applyRecovery(preview.token)
          setPreview(null); setDestination(result.openSession); setItems(await listRecovery())
        }) }}>{t('recoveryConfirm')}</button>
      </div>
    </section>}
    {destination !== null && <p role="status">{t('recoveryDone')} <button type="button" onClick={() => openSession(destination)}>{t('recoveryOpen')}</button></p>}
    <div className={css.buttons}><button type="button" disabled={pending} onClick={() => { void run(async () => { setPreview(null); setItems(await listRecovery()) }) }}>{t('snapshotRefresh')}</button></div>
  </section>
}
