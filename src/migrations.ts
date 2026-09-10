/** Versioned maintenance tasks share one scanner, confirmation and backup workflow. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { migrateFile, repairArtifact } from './migrate-session-logs.ts'
import type { MigrationPlan, MigrationReport, MigrationTaskInfo } from './wire.ts'

export interface MigrationTask extends MigrationTaskInfo {
  /** Pure, idempotent format transformation. Zero changes means already compatible. */
  transform: typeof repairArtifact
}

/** Add future migrations here; never change the identity/meaning of a released task. */
export const MIGRATIONS: readonly MigrationTask[] = [{
  id: 'legacy-session-events-v1', from: '0.2.x / early preview', to: '0.3.0+',
  name: 'Legacy session compatibility', nameZh: '旧版会话兼容迁移',
  transform: repairArtifact,
}]
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export class MigrationManager {
  private readonly busy = new Set<string>()
  private plan: { value: MigrationPlan; expires: number; files: { id: string; path: string; hash: string }[] } | undefined
  private executing = false

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

  async scan(taskId: string, signal?: AbortSignal): Promise<MigrationPlan> {
    if (this.executing) throw new Error('A migration is already running.')
    this.plan = undefined
    const task = this.tasks.find(item => item.id === taskId)
    if (task === undefined) throw new Error('Unknown migration task.')
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('Session persistence is not available.')
    const headers = await persistence.list(signal)
    const entries: MigrationPlan['entries'][number][] = []
    const files: { id: string; path: string; hash: string }[] = []
    for (const header of headers) {
      signal?.throwIfAborted()
      const location = persistence.locate(header)
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
    const value: MigrationPlan = { token: randomUUID(), task: task.id, scanned: headers.length, entries }
    this.plan = { value, files, expires: Date.now() + 300_000 }
    return value
  }

  async execute(token: string, signal?: AbortSignal): Promise<MigrationReport> {
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
