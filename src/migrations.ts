/** Versioned maintenance tasks share one scanner, confirmation and backup workflow. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { migrateFile, repairArtifact, migrateStatusTitles } from './migrate-session-logs.ts'
import { listStoredSessions } from './subagents.ts'
import type { SubagentCarryStore } from './subagents.ts'
import type { MigrationPlan, MigrationReport, MigrationTaskInfo, AutomaticMigrationStatus } from './wire.ts'

export interface MigrationTask extends MigrationTaskInfo {
  /** Pure, idempotent format transformation. Zero changes means already compatible. */
  transform: typeof repairArtifact
}

/** Add future migrations here; never change the identity/meaning of a released task. */
export const MIGRATIONS: readonly MigrationTask[] = [{
  id: 'legacy-session-events-v1', from: '0.2.x / early preview', to: '0.3.0+',
  name: 'Legacy session compatibility', nameZh: '旧版会话兼容迁移',
  transform: repairArtifact,
}, {
  id: 'branch-status-titles-v1', from: 'legacy ↩ titles', to: 'Active / Inactive',
  name: 'Branch status title markers', nameZh: '红绿灯分支标记迁移',
  transform: migrateStatusTitles,
}]
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export class MigrationManager {
  private readonly busy = new Set<string>()
  private plan: { value: MigrationPlan; expires: number; files: { id: string; path: string; hash: string }[] } | undefined
  private executing = false
  private automatic: AutomaticMigrationStatus = { running: false, started: false, reports: [] }

  automaticStatus(): AutomaticMigrationStatus { return this.automatic }

  async runAutomatic(signal?: AbortSignal): Promise<void> {
    if (this.automatic.running || this.executing) return
    this.automatic = { running: true, started: true, reports: [] }
    try {
      for (const task of this.tasks) {
        signal?.throwIfAborted()
        const plan = await this.scan(task.id, signal, true)
        const report = await this.execute(plan.token, signal, true)
        const skipped = plan.entries.filter(row => row.state !== 'ready').map(row => ({
          session: row.session, state: row.state === 'error' ? 'error' as const : 'skipped' as const,
          detail: row.detail ?? 'The conversation is loaded; retry after closing it or on the next launch.',
        }))
        this.automatic = { ...this.automatic, reports: [...this.automatic.reports, { ...report, entries: [...report.entries, ...skipped] }] }
      }
    } catch (error) { this.automatic = { ...this.automatic, error: String(error) } }
    finally { this.automatic = { ...this.automatic, running: false } }
  }

  constructor(private readonly ctx: Context, private readonly tasks: readonly MigrationTask[] = MIGRATIONS) {
    // A synchronous publication veto fences cold resumes while replacing an artifact.
    // Existing live owners are refused below, before any filesystem mutation.
    ctx.on('session/created', session => {
      if (this.busy.has(session.id)) throw new Error('FileSnap is migrating this conversation. Try opening it again after migration finishes.')
    })
  }

  catalogue(): MigrationTaskInfo[] {
    return this.tasks.map(({ transform: _transform, ...info }) => info)
  }

  async scan(taskId: string, signal?: AbortSignal, automatic = false): Promise<MigrationPlan> {
    if (this.automatic.running && !automatic) throw new Error('Automatic migration is running. Wait for it to finish.')
    if (this.executing) throw new Error('A migration is already running.')
    this.plan = undefined
    const task = this.tasks.find(item => item.id === taskId)
    if (task === undefined) throw new Error('Unknown migration task.')
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session persistence is not available.')
    const store = persistence as unknown as SubagentCarryStore
    const listings = await listStoredSessions(store, signal)
    const entries: MigrationPlan['entries'][number][] = []
    const files: { id: string; path: string; hash: string }[] = []
    for (const { header, formatStatus } of listings) {
      signal?.throwIfAborted()
      // The backend's own verdict on the stored format: an artifact it already
      // reads in full has nothing for these legacy repairs to do, and the
      // transform would only refuse its header.
      if (formatStatus === 'current') continue
      const location = store.locate?.(header)
      if (location?.kind !== 'jsonl') {
        entries.push({ session: header.id, state: 'unsupported', events: 0, detail: 'This task supports the JSONL session backend only.' })
        continue
      }
      try {
        const bytes = await readFile(location.path)
        const result = task.transform(bytes, location.path.endsWith('.zstd'))
        if (result.events === 0) continue
        const live = this.ctx.get('sessions')?.get(header.id) !== undefined
        entries.push({ session: header.id, state: live ? 'busy' : 'ready', events: result.events })
        if (!live) files.push({ id: header.id, path: location.path, hash: digest(bytes) })
      } catch (error) { entries.push({ session: header.id, state: 'error', events: 0, detail: String(error) }) }
    }
    const value: MigrationPlan = { token: randomUUID(), task: task.id, scanned: listings.length, entries }
    this.plan = { value, files, expires: Date.now() + 300_000 }
    return value
  }

  async execute(token: string, signal?: AbortSignal, automatic = false): Promise<MigrationReport> {
    if (this.automatic.running && !automatic) throw new Error('Automatic migration is running. Wait for it to finish.')
    const plan = this.plan
    this.plan = undefined
    if (this.executing || plan === undefined || plan.value.token !== token || plan.expires < Date.now()) throw new Error('Migration confirmation expired. Scan again.')
    const task = this.tasks.find(item => item.id === plan.value.task)!
    const entries: MigrationReport['entries'][number][] = []
    this.executing = true
    try {
      for (const file of plan.files) {
        if (signal?.aborted) { entries.push({ session: file.id, state: 'skipped', detail: 'Cancelled before migrating this session.' }); continue }
        this.busy.add(file.id)
        try {
          if (this.ctx.get('sessions')?.get(SessionId(file.id)) !== undefined) {
            entries.push({ session: file.id, state: 'skipped', detail: 'The conversation is currently loaded. Close it and scan again.' })
            continue
          }
          const result = await migrateFile(file.path, true, file.hash, task.transform)
          entries.push({ session: file.id, state: result.events === 0 ? 'skipped' : 'migrated', backup: result.backup })
        } catch (error) { entries.push({ session: file.id, state: 'error', detail: String(error) }) }
        finally { this.busy.delete(file.id) }
      }
    } finally { this.executing = false }
    return { task: task.id, entries }
  }
}


declare module '@deepseek-ai/cordis' {
  interface Context { filesnapMigrations: MigrationManager }
}

/** Run upgrade tasks on host load, when persistence and live ownership are known. */
export function registerMigrations(ctx: Context, automatic = true): void {
  ctx.inject(['sessions', 'sessionPersistence'], scope => {
    const manager = new MigrationManager(scope)
    scope.provide('filesnapMigrations', manager)
    if (automatic) scope.effect(() => {
      const abort = new AbortController()
      const timer = setTimeout(() => { void manager.runAutomatic(abort.signal) }, 0)
      return () => { clearTimeout(timer); abort.abort() }
    })
  })
}
