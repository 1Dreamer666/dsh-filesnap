/** Independent authenticated UI transport; never dispatches chat commands or appends events. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { FilesnapRewind } from './service.ts'
import { redoResult, refusalResult, rewindResult } from './commands.ts'
import type { RewindResult } from './types.ts'
import { selectPoint } from './points.ts'
import { MigrationManager } from './migrations.ts'
import type { UiReply } from './wire.ts'

const requestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  point: z.string().min(1).max(300).optional(),
  token: z.string().uuid().optional(),
  child: z.string().min(1).max(200).optional(),
}).strict()

export async function uiRequest(
  ctx: Context, service: FilesnapRewind, endpoint: string, payload: unknown, signal: AbortSignal,
): Promise<UiReply> {
  const input = requestSchema.parse(payload)
  const agent = ctx.agents.get(SessionId(input.sessionId))
  if (agent === undefined) return { ok: false, error: 'Open this conversation before using FileSnap.' }
  const unwrap = <T>(result: RewindResult<T>): T => {
    if (!result.ok) throw new Error(refusalResult(result.refusal).text)
    return result.value
  }
  switch (endpoint) {
    case 'points': return { ok: true, points: unwrap(await service.points(agent, signal)) }
    case 'preview': {
      if (input.point === undefined) throw new Error('A rewind point is required.')
      return { ok: true, preview: unwrap(await service.preview(agent, input.point, signal)) }
    }
    case 'rewind': {
      if (input.point === undefined || input.token === undefined || input.child === undefined) throw new Error('Preview and confirmation are required.')
      const child = ctx.get('sessions')?.get(SessionId(input.child))
      if (child === undefined || child.header.parentSession !== agent.session.id || child.header.cwd !== agent.session.header.cwd) {
        throw new Error('The destination must be a live fork of this conversation in the same workspace.')
      }
      const point = selectPoint(unwrap(await service.points(agent, signal)), input.point)
      const inherited = child.snapshotEvents().slice(0, child.inheritedEventCount)
      const lastTurn = inherited.findLast(event => event.type === 'turn/start')
      if (point === undefined || lastTurn?.type !== 'turn/start' || lastTurn.data.turn !== point.turn - 1
        || child.snapshotEvents().slice(child.inheritedEventCount).some(event => event.type === 'turn/start')) {
        throw new Error('The destination branch no longer matches the previewed turn. Preview again.')
      }
      const result = unwrap(await service.rewind(agent, input.point, { kind: 'into', session: child.id }, signal, input.token))
      return { ok: true, child: result.child, promptText: result.promptText, message: result.failures.length === 0 ? undefined : rewindResult(result).text }
    }
    case 'redo': {
      const result = unwrap(await service.redo(agent, signal))
      return { ok: true, child: result.returnedTo, message: redoResult(result).text }
    }
    case 'status': return { ok: true, status: unwrap(await service.status(agent, signal)) }
    case 'cleanup-preview': return { ok: true, cleanup: unwrap(await service.previewCleanup(agent, signal)) }
    case 'cleanup': {
      if (input.token === undefined) throw new Error('Cleanup confirmation is required.')
      return { ok: true, cleaned: unwrap(await service.cleanup(agent, input.token, signal)) }
    }
    default: throw new Error('Unknown FileSnap operation.')
  }
}

export function registerRpc(ctx: Context): void {
  ctx.inject(['connection', 'filesnap'], (rpcCtx) => {
    const migrations = new MigrationManager(rpcCtx)
    rpcCtx.connection.rpc.handle('/filesnap', async (endpoint, payload, signal) => {
      try {
        if (endpoint === 'migration-list') { z.object({}).strict().parse(payload); return { ok: true, value: migrations.catalogue() } }
        if (endpoint === 'migration-scan') { const input = z.object({ task: z.string() }).strict().parse(payload); return { ok: true, value: await migrations.scan(input.task, signal) } }
        if (endpoint === 'migration-apply') { const input = z.object({ token: z.string().uuid() }).strict().parse(payload); return { ok: true, value: await migrations.execute(input.token, signal) } }
        return { ok: true, value: await uiRequest(rpcCtx, rpcCtx.filesnap, endpoint, payload, signal) }
      }
      catch (error) { return { ok: true, value: { ok: false, error: String(error instanceof Error ? error.message : error) } satisfies UiReply } }
    })
  })
}
