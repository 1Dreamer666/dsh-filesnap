import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MigrationPlan, MigrationReport, MigrationTaskInfo } from '../wire.ts'
import css from './RewindAction.module.css'

export interface MigrationActions {
  list: () => Promise<MigrationTaskInfo[]>
  scan: (task: string) => Promise<MigrationPlan>
  migrate: (token: string) => Promise<MigrationReport>
}

/** Shared settings entry for present and future versioned migrations. */
export function MigrationPanel({ list, scan, migrate, t }: MigrationActions & PropsLocale<'filesnap'>) {
  const [tasks, setTasks] = useState<MigrationTaskInfo[]>([])
  const [task, setTask] = useState('')
  const [plan, setPlan] = useState<MigrationPlan | null>(null)
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    const ticket = ++generation.current
    void list().then(rows => {
      if (ticket !== generation.current) return
      setTasks(rows); setTask(rows[0]?.id ?? '')
    }).catch(e => { if (ticket === generation.current) setError(String(e)) })
    return () => { generation.current++ }
  }, [list])
  const run = async (confirm: boolean) => {
    if (busy.current || task === '' || (confirm && plan === null)) return
    busy.current = true; setPending(true); setError(null); setReport(null)
    const ticket = ++generation.current
    try {
      if (confirm) {
        const result = await migrate(plan!.token)
        if (ticket === generation.current) { setReport(result); setPlan(null) }
      } else {
        setPlan(null)
        const result = await scan(task)
        if (ticket === generation.current) setPlan(result)
      }
    } catch (failure) { if (ticket === generation.current) { setError(String(failure)); setPlan(null) } }
    finally { if (ticket === generation.current) { busy.current = false; setPending(false) } }
  }
  return <section className={css.settings}>
    <h2>{t('migrationTitle')}</h2>
    <p>{t('migrationIntro')}</p>
    <label>{t('migrationTask')}
      <select value={task} disabled={pending} onChange={e => { setTask(e.target.value); setPlan(null); setReport(null) }}>
        {tasks.map(row => <option key={row.id} value={row.id}>{row.from} → {row.to} · {row.nameZh} / {row.name}</option>)}
      </select>
    </label>
    <p className={css.muted}>{t('migrationSafety')}</p>
    {pending && <p role="status">{t('migrationWorking')}</p>}
    {error !== null && <p role="alert" className={css.failure}>{error}</p>}
    {plan !== null && <>
      <p>{t('migrationScanned', { count: String(plan.scanned), ready: String(plan.entries.filter(row => row.state === 'ready').length) })}</p>
      {plan.entries.length === 0 && <p role="status">{t('migrationNone')}</p>}
      <ul className={css.sessions}>{plan.entries.map(row => <li key={row.session}>
        <code>{row.session}</code><span>{t(`migration_${row.state}`)} · {row.events}</span>
        {row.detail !== undefined && <small className={css.path}>{row.detail}</small>}
      </li>)}</ul>
    </>}
    {report !== null && <>
      <p role="status">{t('migrationFinished')}</p>
      <ul className={css.sessions}>{report.entries.map(row => <li key={row.session}>
        <code>{row.session}</code><span>{t(`migration_${row.state}`)}</span>
        {row.backup !== undefined && <small className={css.path}>{t('migrationBackup')}: {row.backup}</small>}
        {row.detail !== undefined && <small className={css.path}>{row.detail}</small>}
      </li>)}</ul>
    </>}
    <div className={css.buttons}>
      <button type="button" disabled={pending || task === ''} onClick={() => { void run(false) }}>{t('migrationScan')}</button>
      {plan !== null && <button type="button" disabled={pending || !plan.entries.some(row => row.state === 'ready')} onClick={() => { void run(true) }}>{t('migrationConfirm')}</button>}
    </div>
  </section>
}
