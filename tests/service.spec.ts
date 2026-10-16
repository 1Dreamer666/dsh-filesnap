/**
 * The service against a real Cordis context, a real Session, and the real
 * engine. This is where the sequencing is asserted — the fork happening before
 * the restore, the undo record landing in the child, the durable record of what
 * happened — because none of that is visible from either half alone.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { registerCommands } from '../src/commands.ts'
import type { CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { resolveConfig } from '../src/config.ts'
import { uiRequest } from '../src/rpc.ts'
import { FilesnapRewind } from '../src/service.ts'
import { BINARY, nodeSubprocess, scratch } from './support.ts'

/** One detached session bound to a working directory. The header is frozen at construction, so lineage is passed in. */
function sessionAt(id: string, cwd: string, parent?: string): Session {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    isSeeded: false,
    id: SessionId(id),
    createdAt: 1_700_000_000_000,
    cwd,
    ...parent === undefined ? {} : { parentSession: SessionId(parent) },
  }
  return Session.create(SessionId(id), undefined, header)
}

/** Build a session and register it as live, so `retitle` accepts it. */
function liveSessionAt(live: Map<string, Session>, id: string, cwd: string, parent?: string): Session {
  const session = sessionAt(id, cwd, parent)
  live.set(id, session)
  return session
}

/** The slice of `Agent` this service reads. */
function agentOn(session: Session, status: 'idle' | 'running' = 'idle'): Agent {
  return {
    id: session.header.id,
    session,
    status,
    options: { provider: 'mock', model: 'mock' },
  } as unknown as Agent
}

/**
 * Open a turn, prompt it, answer it, and close it — the shape the loop writes.
 *
 * The answer is not decoration. A point anchors on the message that closed the
 * turn before it, so a log without assistant messages produces points no fork
 * can be built from, and every rewind assertion below would pass or fail for
 * the wrong reason.
 */
async function runTurn(
  session: Session,
  turn: number,
  text: string,
  capture: () => Promise<void> | void,
): Promise<void> {
  session.append('turn/start', { turn })
  // Awaited, not fired: the capture appends the point, and a point that lands
  // after its own `turn/end` anchors on the wrong message.
  await capture()
  session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer to ${text}` }],
        source: { provider: 'mock', model: 'mock' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function confirmRedo(service: FilesnapRewind, agent: Agent) {
  const preview = await service.previewRedo(agent)
  if (!preview.ok) throw new Error(JSON.stringify(preview.refusal))
  return service.redo(agent, undefined, preview.value.token)
}

describe.skipIf(BINARY === undefined)('FilesnapRewind', () => {
  let workspace: ReturnType<typeof scratch>
  let store: ReturnType<typeof scratch>
  let ctx: Context
  let service: FilesnapRewind
  let fiber: Awaited<ReturnType<Context['plugin']>>
  let forked: { id: SessionId; seed: readonly SessionEvent[]; parent?: SessionId }[]
  /** Sessions the store considers live, by id. */
  let live: Map<string, Session>

  beforeEach(async () => {
    workspace = scratch('filesnap-svc-ws')
    store = scratch('filesnap-svc-store')
    forked = []
    live = new Map()
    ctx = new Context()
    ctx.provide('subprocess', nodeSubprocess())
    // The slice `retitle` uses: liveness, checked by identity.
    ctx.provide('sessions', { get: (id: string) => live.get(id) })
    ctx.provide('agents', {
      get: (id: string) => live.has(id) ? agentOn(live.get(id)!) : undefined,
      create(options: { sessionId: SessionId; seed?: readonly SessionEvent[]; meta?: { parentSession?: SessionId } }) {
        forked.push({
          id: options.sessionId,
          seed: options.seed ?? [],
          ...options.meta?.parentSession === undefined ? {} : { parent: options.meta.parentSession },
        })
        return Promise.resolve({})
      },
    })
    fiber = await ctx.plugin(FilesnapRewind, resolveConfig({
      /* v8 ignore next -- the suite is skipped when the binary is absent */
      command: BINARY ?? '',
      dataDir: store.path,
      timeoutMs: 60_000,
    }))
    service = ctx.filesnap
  })

  afterEach(async () => {
    await fiber.dispose()
    workspace.remove()
    store.remove()
  })

  it('serves points, previews, status and cleanup over RPC without adding conversation events', async () => {
    const session = liveSessionAt(live, 'rpc-session', workspace.path)
    const agent = agentOn(session)
    writeFileSync(join(workspace.path, 'a.txt'), 'original')
    await runTurn(session, 1, 'look', () => service.capture(agent, 1))
    await runTurn(session, 2, 'edit', () => service.capture(agent, 2))
    writeFileSync(join(workspace.path, 'a.txt'), 'edited')
    const before = session.snapshotEvents()
    const request = (endpoint: string, args: object = {}) => uiRequest(ctx, service, endpoint, { sessionId: session.id, ...args }, new AbortController().signal)
    expect((await request('points')).points).toHaveLength(2)
    const filePreview = await request('preview', { point: '2' })
    expect(filePreview.preview?.changes).toHaveLength(1)
    expect((await request('status')).status?.recordsBytes).toBeGreaterThan(0)
    const preview = await request('cleanup-preview')
    expect(preview.cleanup).toBeDefined()
    expect((await request('cleanup', { token: preview.cleanup!.token })).cleaned).toBeDefined()
    expect((await service.points(agent)).ok).toBe(true)
    expect(session.snapshotEvents()).toEqual(before)
    await expect(request('rewind', { point: '2' })).rejects.toThrow('confirmation')
    await expect(request('status', { unexpected: 'value' })).rejects.toThrow()
    const wrongSeed = session.snapshotEvents()
    const wrong = Session.create(SessionId('wrong-cut'), wrongSeed, { ...session.header, id: SessionId('wrong-cut'), parentSession: session.id, isSeeded: true }, SessionLogOffset(wrongSeed.length))
    live.set(wrong.id, wrong)
    await expect(request('rewind', { point: '2', token: filePreview.preview!.token, child: wrong.id })).rejects.toThrow('no longer matches')
    expect(readFileSync(join(workspace.path, 'a.txt'), 'utf8')).toBe('edited')
    const cut = session.snapshotEvents().findIndex(e => e.type === 'turn/start' && e.data.turn === 2)
    const seed = session.snapshotEvents().slice(0, cut)
    const child = Session.create(SessionId('rpc-child'), seed, { ...session.header, id: SessionId('rpc-child'), parentSession: session.id, isSeeded: true }, SessionLogOffset(seed.length))
    live.set(child.id, child)
    expect(await request('rewind', { point: '2', token: filePreview.preview!.token, child: child.id })).toMatchObject({ ok: true, child: 'rpc-child', promptText: 'edit' })
    expect(readFileSync(join(workspace.path, 'a.txt'), 'utf8')).toBe('original')
    expect(session.snapshotEvents()).toEqual(before)

  })

  it('rejects expired cleanup confirmations without losing snapshots', async () => {
    const session = sessionAt('cleanup-session', workspace.path)
    const agent = agentOn(session)
    await runTurn(session, 1, 'look', () => service.capture(agent, 1))
    expect((await service.cleanup(agent, 'not-issued')).ok).toBe(false)
    const preview = await service.previewCleanup(agent)
    if (!preview.ok) throw new Error('preview failed')
    expect((await service.cleanup(agent, preview.value.token)).ok).toBe(true)
    expect((await service.cleanup(agent, preview.value.token)).ok).toBe(false)
    expect(await service.points(agent)).toMatchObject({ ok: true, value: [{ point: 'cleanup-session.t1' }] })
  })

  it('records a rewind point per captured turn', async () => {
    const session = sessionAt('session-a', workspace.path)
    writeFileSync(join(workspace.path, 'a.txt'), 'v1\n')
    const agent = agentOn(session)

    session.append('turn/start', { turn: 1 })
    await service.capture(agent, 1)

    expect(await service.points(agent)).toMatchObject({ ok: true, value: [{ turn: 1, point: 'session-a.t1' }] })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start'])

  })

  it('previews real writes, missing files and deletions, without forking or restoring until confirmation', async () => {
    const session = sessionAt('preview-session', workspace.path)
    const agent = agentOn(session)
    const changed = join(workspace.path, '改动.txt')
    const missing = join(workspace.path, 'missing.txt')
    const created = join(workspace.path, 'created.txt')
    const unchanged = join(workspace.path, 'unchanged.txt')
    for (const file of [changed, missing, unchanged]) writeFileSync(file, 'original')
    await runTurn(session, 1, 'look', () => service.capture(agent, 1))
    await runTurn(session, 2, 'edit', async () => {
      await service.capture(agent, 2)
      await service.declare(agent, 2, [created])
      writeFileSync(created, 'new')
      writeFileSync(changed, 'changed')
      unlinkSync(missing)
    })
    const plan = await service.preview(agent, '2')
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error(JSON.stringify(plan))
    expect(plan.value.changes).toEqual(expect.arrayContaining([
      { path: changed, action: 'write' }, { path: missing, action: 'write' }, { path: created, action: 'delete' },
    ]))
    expect(plan.value.changes).toHaveLength(3)
    expect(forked).toHaveLength(0)
    expect(readFileSync(changed, 'utf8')).toBe('changed')
    expect(existsSync(missing)).toBe(false)
    expect(existsSync(created)).toBe(true)
    expect(session.snapshotEvents().some(event => event.type.startsWith('filesnap/'))).toBe(false)
    const result = await service.rewind(agent, '2', { kind: 'fork' }, undefined, plan.value.token)
    expect(result.ok).toBe(true)
    expect(readFileSync(changed, 'utf8')).toBe('original')
    expect(readFileSync(missing, 'utf8')).toBe('original')
    expect(existsSync(created)).toBe(false)
    expect(forked).toHaveLength(1)
    const repeated = await service.rewind(agent, '2', { kind: 'fork' }, undefined, plan.value.token)
    expect(repeated.ok).toBe(false)
    expect(forked).toHaveLength(1)
  })

  it.each(['files', 'ignore rules'])('refuses stale confirmation after %s change without creating a branch', async (change) => {
    const session = sessionAt('stale-session', workspace.path)
    const agent = agentOn(session)
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'original')
    await runTurn(session, 1, 'look', () => service.capture(agent, 1))
    await runTurn(session, 2, 'edit', () => service.capture(agent, 2))
    writeFileSync(file, 'edited')
    const preview = await service.preview(agent, '2')
    if (!preview.ok) throw new Error(JSON.stringify(preview))
    if (change === 'files') writeFileSync(file, 'newer edit')
    else writeFileSync(join(workspace.path, '.filesnapignore'), 'a.txt\n')
    const result = await service.rewind(agent, '2', { kind: 'fork' }, undefined, preview.value.token)
    expect(result).toMatchObject({ ok: false, refusal: { kind: 'engine', message: expect.stringContaining('changed after preview') } })
    expect(forked).toHaveLength(0)
    expect(readFileSync(file, 'utf8')).toBe(change === 'files' ? 'newer edit' : 'edited')
  })

  it('previews an empty change list and rejects missing confirmation tokens', async () => {
    const session = sessionAt('empty-preview', workspace.path)
    const agent = agentOn(session)
    await runTurn(session, 1, 'look', () => service.capture(agent, 1))
    await runTurn(session, 2, 'look again', () => service.capture(agent, 2))
    const preview = await service.preview(agent, '2')
    expect(preview.ok && preview.value.changes).toEqual([])
    const result = await service.rewind(agent, '2', { kind: 'fork' }, undefined, 'not-issued')
    expect(result.ok).toBe(false)
    expect(forked).toHaveLength(0)
  })

  it('captures a turn once, however often the step is proposed', async () => {
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    session.append('turn/start', { turn: 1 })
    await service.capture(agent, 1)
    await service.capture(agent, 1)
    await service.capture(agent, 1)
    expect((await service.points(agentOn(session))).ok).toBe(true)
    expect(session.snapshotEvents().filter(event => event.type.startsWith('filesnap/'))).toHaveLength(0)
  })

  it('does not recapture after the plugin restarts', async () => {
    const session = sessionAt('session-a', workspace.path)
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'original')
    await runTurn(session, 1, 'look', () => service.capture(agentOn(session), 1))
    session.append('turn/start', { turn: 2 })
    await service.capture(agentOn(session), 2)
    writeFileSync(file, 'changed')
    await fiber.dispose()
    fiber = await ctx.plugin(FilesnapRewind, resolveConfig({ command: BINARY, dataDir: store.path }))
    service = ctx.filesnap
    await service.capture(agentOn(session), 2)
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const result = await service.rewind(agentOn(session), '2', { kind: 'into', session: SessionId('heir') })
    expect(result.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('leaves a session with no working directory alone', async () => {
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('session-nowhere'), createdAt: 1, ...{} }
    const session = Session.create(SessionId('session-nowhere'), undefined, header)
    session.append('turn/start', { turn: 1 })
    await service.capture(agentOn(session), 1)
    expect(session.snapshotEvents().some(event => event.type.startsWith('filesnap/'))).toBe(false)

    const points = await service.points(agentOn(session))
    expect(points.ok).toBe(false)
    expect(points.ok || points.refusal.kind).toBe('untracked')
  })

  it('offers only the points the store can still resolve', async () => {
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    writeFileSync(join(workspace.path, 'a.txt'), 'v1\n')
    await runTurn(session, 1, 'first change', () => {})
    // Turn 1 was never captured, so the log has a turn the engine cannot resolve.
    await runTurn(session, 2, 'second change', () => {})
    await service.capture(agent, 2)

    const points = await service.points(agent)
    expect(points.ok).toBe(true)
    expect(points.ok && points.value.map(point => point.turn)).toEqual([2])
    expect(points.ok && points.value[0]?.label).toBe('second change')
  })

  it('still offers a point its parent captured, in a session that has captured nothing', async () => {
    // What a fork leaves behind. The child's log carries the parent's points
    // verbatim, but `filesnap log --session <child>` lists only what the CHILD
    // captured — so filtering against that set drops every inherited point,
    // which is every point a freshly forked session has.
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'original\n')

    const parent = sessionAt('session-a', workspace.path)
    const parentAgent = agentOn(parent)
    await runTurn(parent, 1, 'first', async () => { await service.capture(parentAgent, 1) })
    await runTurn(parent, 2, 'second', async () => { await service.capture(parentAgent, 2) })

    // The child inherits the parent's log and has captured nothing itself.
    // The assistant messages come across with it: a seed without them carries
    // points no fork can anchor on, which is not what a fork looks like.
    live.set(parent.id, parent)
    const seed = parent.snapshotEvents()
    const child = Session.create(SessionId('session-b'), seed, {
      ...parent.header, id: SessionId('session-b'), parentSession: parent.id, isSeeded: true,
    }, SessionLogOffset(seed.length))
    const heir = agentOn(child)

    const points = await service.points(heir)
    expect(points.ok).toBe(true)
    expect(points.ok && points.value.map(point => point.point)).toEqual(['session-a.t1', 'session-a.t2'])

    writeFileSync(file, 'wrecked\n')
    const outcome = await service.rewind(heir, '2', { kind: 'into', session: SessionId('session-c') })
    expect(outcome.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('original\n')
  })

  it('resolves a nested fork through cold native ancestors and never borrows their excluded turns', async () => {
    const parent = sessionAt('ancestor', workspace.path)
    const agent = agentOn(parent)
    for (const turn of [1, 2, 3]) await runTurn(parent, turn, `p${turn}`, () => service.capture(agent, turn))
    const cut = parent.snapshotEvents().findIndex(e => e.type === 'turn/start' && e.data.turn === 3)
    const seed = parent.snapshotEvents().slice(0, cut)
    const child = Session.create(SessionId('branch'), seed, { ...parent.header, id: SessionId('branch'), parentSession: parent.id, isSeeded: true }, SessionLogOffset(seed.length))
    await runTurn(child, 3, 'branch edit', () => service.capture(agentOn(child), 3))
    const childSeed = child.snapshotEvents()
    const grandchild = Session.create(SessionId('nested'), childSeed, { ...child.header, id: SessionId('nested'), parentSession: child.id }, SessionLogOffset(childSeed.length))
    const ancestors = new Map([[parent.id, parent], [child.id, child]])
    ctx.provide('sessionPersistence', { inspect: async (id: SessionId) => {
      const source = ancestors.get(id)!
      return { meta: source.header, events: source.snapshotEvents(), inheritedEventCount: source.inheritedEventCount }
    } })
    expect(await service.points(agentOn(grandchild))).toMatchObject({ ok: true, value: [
      { point: 'ancestor.t1' }, { point: 'ancestor.t2' }, { point: 'branch.t3' },
    ] })
  })

  it('forks the conversation, then restores the files into the fork', async () => {
    const file = join(workspace.path, 'a.txt')
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)

    writeFileSync(file, 'original\n')
    await runTurn(session, 1, 'set it up', async () => { await service.capture(agent, 1) })
    const afterFirstTurn = session.snapshotEvents().length
    await runTurn(session, 2, 'break it', async () => { await service.capture(agent, 2) })
    writeFileSync(file, 'something regrettable\n')

    const outcome = await service.rewind(agent, '2')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // The files half landed.
    expect(readFileSync(file, 'utf8')).toBe('original\n')
    expect(outcome.value.written).toBe(1)
    expect(outcome.value.failures).toEqual([])
    expect(outcome.value.safety).toMatch(/^[0-9a-f]{64}$/u)

    // The conversation half kept the turn the workspace was handed back from,
    // and dropped the one being undone. Those two have to agree: a child that
    // still shows the turn whose writes were just reverted is a conversation
    // claiming work its files no longer hold.
    expect(forked).toHaveLength(1)
    expect(forked[0]?.parent).toBe('session-a')
    expect(forked[0]?.seed).toHaveLength(afterFirstTurn)
    expect(forked[0]?.seed.at(-1)?.type).toBe('turn/end')
    expect(forked[0]?.seed.some(event => event.type === 'turn/start' && event.data.turn === 2)).toBe(false)
    expect(outcome.value.child).toBe(forked[0]?.id)

    expect(session.snapshotEvents().some(event => event.type.startsWith('filesnap/'))).toBe(false)

  })

  it("carries the rewound session's subagents into the caller's live branch", async () => {
    const file = join(workspace.path, 'a.txt')
    const session = liveSessionAt(live, 'session-a', workspace.path)
    const agent = agentOn(session)
    writeFileSync(file, 'original\n')
    await runTurn(session, 1, 'set it up', async () => { await service.capture(agent, 1) })
    const afterFirstTurn = session.snapshotEvents().length
    // A child spawned inside the retained turn: stored under the session the
    // rewind leaves, created no later than the retained history's last event.
    const child = Session.create(SessionId('subagent-child'), undefined, {
      version: SESSION_FORMAT_VERSION,
      isSeeded: false,
      id: SessionId('subagent-child'),
      createdAt: session.snapshotEvents().at(-1)!.time,
      cwd: workspace.path,
      parentSession: session.id,
      origin: 'subagent',
      delegationDepth: 1,
    })
    child.append('turn/start', { turn: 1 })
    const created: { header: SessionHeader; events: readonly SessionEvent[] }[] = []
    const records = new Map<string, { header: SessionHeader; events: readonly SessionEvent[] }>([
      [String(child.id), { header: child.header, events: child.snapshotEvents() }],
    ])
    // The 0.1.2 persistence surface: raw header lists, `inspect`, and
    // id-addressed writes. The linked harness composes no catalog vocabulary,
    // so the carry may clone but must not append events to this session.
    ctx.provide('sessionPersistence', {
      list: async () => [...records.values()].map(record => record.header),
      inspect: async (id: string) => {
        const record = records.get(id)
        if (record === undefined) throw new Error(`session "${id}" is not stored`)
        return { meta: record.header, events: record.events, inheritedEventCount: 0 }
      },
      create: async (header: SessionHeader) => {
        const record = { header, events: [] as readonly SessionEvent[] }
        records.set(String(header.id), record)
        created.push(record)
      },
      append: async (id: string, events: readonly SessionEvent[]) => {
        const record = records.get(id)
        if (record === undefined) throw new Error(`session "${id}" is not stored`)
        record.events = events
      },
    } as unknown as Context['sessionPersistence'])
    await runTurn(session, 2, 'break it', async () => { await service.capture(agent, 2) })

    const seed = session.snapshotEvents().slice(0, afterFirstTurn)
    const branch = Session.create(SessionId('branch'), seed, { ...session.header, id: SessionId('branch'), parentSession: session.id, isSeeded: true }, SessionLogOffset(seed.length))
    live.set('branch', branch)
    const before = branch.snapshotEvents()

    const outcome = await service.rewind(agent, '2', { kind: 'into', session: branch.id })
    expect(outcome.ok).toBe(true)

    expect(created).toHaveLength(1)
    const clone = created[0]!
    expect(clone.header.id).not.toBe(child.id)
    expect(clone.header.parentSession).toBe(branch.id)
    expect(clone.header.origin).toBe('subagent')
    expect(clone.header.createdAt).toBe(child.header.createdAt)
    expect(clone.events).toEqual(child.snapshotEvents())
    expect(branch.snapshotEvents()).toEqual(before)
  })

  it('cuts the fork at the end of the previous turn, not inside the one being rewound', async () => {
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    writeFileSync(join(workspace.path, 'a.txt'), 'v1\n')

    await runTurn(session, 1, 'first', async () => { await service.capture(agent, 1) })
    const afterFirstTurn = session.snapshotEvents().length
    await runTurn(session, 2, 'second', async () => { await service.capture(agent, 2) })

    const outcome = await service.rewind(agent, '2')
    expect(outcome.ok).toBe(true)
    expect(forked[0]?.seed).toHaveLength(afterFirstTurn)
    expect(forked[0]?.seed.at(-1)?.type).toBe('turn/end')
  })

  it('treats absent undo as a normal state and archives only a successfully exhausted redo branch', async () => {
    const archiveSession = vi.fn(async (_id: string) => {})
    ctx.provide('workspaceRegistry', { archiveSession })
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'before')
    const parent = liveSessionAt(live, 'parent', workspace.path), agent = agentOn(parent)
    await runTurn(parent, 1, 'look', () => service.capture(agent, 1))
    await runTurn(parent, 2, 'edit', () => service.capture(agent, 2))
    writeFileSync(file, 'after')
    const request = (session: Session, endpoint: string, args: object = {}) => uiRequest(ctx, service, endpoint, { sessionId: session.id, ...args }, new AbortController().signal)
    expect(await request(parent, 'redo-preview')).toEqual({ ok: false, errorCode: 'no-restore' })
    expect(archiveSession).not.toHaveBeenCalled()
    expect((await service.rewind(agent, '2', { kind: 'into', session: SessionId('child') })).ok).toBe(true)
    const child = liveSessionAt(live, 'child', workspace.path, 'parent')
    const preview = (await request(child, 'redo-preview')).redoPreview!
    expect(archiveSession).not.toHaveBeenCalled()
    const result = await request(child, 'redo', { token: preview.token })
    expect(result).toMatchObject({ ok: true, archived: true, child: parent.id })
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith(child.id)
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect(await request(child, 'redo-preview')).toEqual({ ok: false, errorCode: 'no-restore' })
    expect((await service.previewRedo(agentOn(child)))).toEqual({ ok: false, refusal: { kind: 'no-restore' } })
    expect((await service.points(agent)).ok).toBe(true)
    expect(parent.snapshotEvents().some(event => event.type === 'user/message')).toBe(true)
    expect(archiveSession).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost restore result through the service and keeps history free of operation events', async () => {
    const file = join(workspace.path, 'a.txt'), parent = liveSessionAt(live, 'parent', workspace.path)
    const agent = agentOn(parent), child = liveSessionAt(live, 'child', workspace.path, 'parent')
    writeFileSync(file, 'before')
    await runTurn(parent, 1, 'look', () => service.capture(agent, 1))
    await runTurn(parent, 2, 'edit', () => service.capture(agent, 2))
    writeFileSync(file, 'after')
    const hidden = service as unknown as { invoker(): Promise<import('../src/cli.ts').FilesnapCli> }
    const cli = await hidden.invoker()
    let interrupt = true
    vi.spyOn(hidden, 'invoker').mockResolvedValue({ run: async (...args) => {
      const result = await cli.run(...args)
      if (args[0][0] === 'restore' && interrupt) {
        interrupt = false
        return { ...result, exit: 'aborted', code: null, events: [], stderr: 'host lost the result' }
      }
      return result
    } })
    expect((await service.rewind(agent, '2', { kind: 'into', session: child.id })).ok).toBe(false)
    const pending = (await service.recovery.list())[0]!
    expect(pending.source).toBe(parent.id)
    await expect(service.capture(agent, 3)).rejects.toThrow('unfinished')
    const preview = await service.recoveryPreview(pending.id, 'apply')
    expect(preview.changes).toEqual([])
    expect(await service.recover(preview.token)).toMatchObject({ openSession: child.id })
    expect((await confirmRedo(service, agentOn(child))).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect((await service.previewRedo(agentOn(child)))).toEqual({ ok: false, refusal: { kind: 'no-restore' } })
    expect(parent.snapshotEvents().some(row => row.type.startsWith('filesnap/'))).toBe(false)
    expect(child.snapshotEvents().some(row => row.type.startsWith('filesnap/'))).toBe(false)
  })

  it('keeps legacy engine undo reachable underneath new durable redo records', async () => {
    const archiveSession = vi.fn(async (_id: string) => {})
    ctx.provide('workspaceRegistry', { archiveSession })
    const file = join(workspace.path, 'a.txt'), parent = liveSessionAt(live, 'parent', workspace.path)
    const agent = agentOn(parent), child = liveSessionAt(live, 'child', workspace.path, 'parent')
    writeFileSync(file, 'before')
    await runTurn(parent, 1, 'look', () => service.capture(agent, 1))
    await runTurn(parent, 2, 'edit', () => service.capture(agent, 2))
    const available = await service.points(agent)
    if (!available.ok) throw new Error('missing points')
    const point = available.value.find(point => point.turn === 2)!
    const cli = await (service as unknown as { invoker(): Promise<import('../src/cli.ts').FilesnapCli> }).invoker()
    writeFileSync(file, 'legacy rescue')
    expect((await cli.run(['restore', '--session', parent.id, '--turn', point.point, '--undo-for', child.id], workspace.path)).exit).toBe('ok')
    writeFileSync(file, 'new rescue')
    expect((await service.rewind(agent, '2', { kind: 'into', session: child.id })).ok).toBe(true)
    expect((await confirmRedo(service, agentOn(child))).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('new rescue')
    expect(archiveSession).not.toHaveBeenCalled()
    expect((await confirmRedo(service, agentOn(child))).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('legacy rescue')
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith(child.id)
  })

  it('keeps a branch with remaining undo records and preserves redo success if archiving fails', async () => {
    const archiveSession = vi.fn(async (_id: string) => { throw new Error('archive unavailable') })
    ctx.provide('workspaceRegistry', { archiveSession })
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'before')
    const parent = liveSessionAt(live, 'parent', workspace.path), agent = agentOn(parent)
    await runTurn(parent, 1, 'look', () => service.capture(agent, 1))
    await runTurn(parent, 2, 'edit', () => service.capture(agent, 2))
    const child = liveSessionAt(live, 'child', workspace.path, 'parent')
    writeFileSync(file, 'first restore')
    expect((await service.rewind(agent, '2', { kind: 'into', session: child.id })).ok).toBe(true)
    writeFileSync(file, 'second restore')
    expect((await service.rewind(agent, '2', { kind: 'into', session: child.id })).ok).toBe(true)
    const first = await confirmRedo(service, agentOn(child))
    expect(first.ok && first.value.archived).toBe(false)
    expect(archiveSession).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe('second restore')
    const second = await confirmRedo(service, agentOn(child))
    expect(second).toMatchObject({ ok: true, value: { archived: false, archiveError: 'Error: archive unavailable' } })
    expect(readFileSync(file, 'utf8')).toBe('first restore')
    expect(archiveSession).toHaveBeenCalledExactlyOnceWith(child.id)
  })

  it('does not archive a redo with failed files or mislabel other engine errors as an upgrade requirement', async () => {
    const archiveSession = vi.fn(async (_id: string) => {})
    ctx.provide('workspaceRegistry', { archiveSession })
    const child = liveSessionAt(live, 'child', workspace.path, 'parent')
    const run = vi.fn()
    vi.spyOn(service as unknown as { invoker(): Promise<{ run: typeof run }> }, 'invoker').mockResolvedValue({ run })
    const empty = { events: [], refused: 0, code: 3, exit: 'usage' as const, stderr: "error: unexpected argument '--preview' found" }
    run.mockResolvedValueOnce(empty)
    expect(await service.previewRedo(agentOn(child))).toMatchObject({ ok: false, refusal: { message: expect.stringContaining('0.5.1+') } })
    run.mockResolvedValueOnce({ ...empty, exit: 'failed', code: 2, stderr: 'permission denied' })
    const failure = await service.previewRedo(agentOn(child))
    expect(failure).toMatchObject({ ok: false, refusal: { message: 'Cannot preview redo: permission denied' } })
    run.mockResolvedValueOnce({ ...empty, exit: 'ok', code: 0, stderr: '', events: [{ v: 1, type: 'undo.preview', writes: 0, deletes: 0, target: 'target', fingerprint: 'a'.repeat(64) }] })
    const preview = await service.previewRedo(agentOn(child))
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    run.mockResolvedValueOnce({ ...empty, exit: 'partial', code: 1, stderr: '', events: [{ v: 1, type: 'restore.failed', path: '/failed', error: 'permission denied' }, { v: 1, type: 'restore.done', written: 0, deleted: 0, failed: 1, safety: 'saved' }] })
    expect(await service.redo(agentOn(child), undefined, preview.value.token)).toMatchObject({ ok: true, value: { archived: false, failures: [{ path: '/failed', error: 'permission denied' }] } })
    expect(archiveSession).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('requires redo preview and single-use confirmation through both RPC and typed commands', async () => {
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'before')
    const parent = liveSessionAt(live, 'parent', workspace.path)
    const agent = agentOn(parent)
    await runTurn(parent, 1, 'look', () => service.capture(agent, 1))
    await runTurn(parent, 2, 'edit', () => service.capture(agent, 2))
    writeFileSync(file, 'after')
    expect((await service.rewind(agent, '2', { kind: 'into', session: SessionId('child') })).ok).toBe(true)
    const child = liveSessionAt(live, 'child', workspace.path, 'parent')
    const signal = new AbortController().signal
    const rpc = (endpoint: string, args: object = {}) => uiRequest(ctx, service, endpoint, { sessionId: child.id, ...args }, signal)
    await expect(rpc('redo')).rejects.toThrow('confirm')
    expect(readFileSync(file, 'utf8')).toBe('before')
    const preview = (await rpc('redo-preview')).redoPreview!
    expect(preview.changes).toEqual([{ path: file, action: 'write' }])
    writeFileSync(file, 'new edits')
    await expect(rpc('redo', { token: preview.token })).rejects.toThrow('stale')
    expect(readFileSync(file, 'utf8')).toBe('new edits')
    const handlers = new Map<string, (invocation: CommandInvocation) => Promise<CommandResult>>()
    registerCommands({ register: (spec: { name: string; handler: (invocation: CommandInvocation) => Promise<CommandResult> }) => { handlers.set(spec.name, spec.handler) } } as unknown as CommandRuntime, service)
    const command = (rawInput: string) => handlers.get('redo')!({ rawInput, agent: agentOn(child), signal } as CommandInvocation)
    const result = await command('')
    expect(result.text).toContain('WRITE / RESTORE')
    expect(readFileSync(file, 'utf8')).toBe('new edits')
    const token = /--confirm ([\w-]+)/u.exec(result.text!)![1]!
    const confirmed = await command(`--confirm ${token}`)
    expect(confirmed.kind).toBe('success')
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect((await command(`--confirm ${token}`)).kind).toBe('error')
    expect((await command('--force')).kind).toBe('error')
    expect(child.snapshotEvents()).toHaveLength(0)
  })

  it('files the undo record in the fork, so /redo works where the user is standing', async () => {
    const file = join(workspace.path, 'a.txt')
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    writeFileSync(file, 'original\n')
    await runTurn(session, 1, 'set it up', async () => { await service.capture(agent, 1) })
    await runTurn(session, 2, 'later work', async () => { await service.capture(agent, 2) })
    writeFileSync(file, 'later work\n')

    const rewound = await service.rewind(agent, '2')
    expect(rewound.ok).toBe(true)
    if (!rewound.ok) return
    expect(readFileSync(file, 'utf8')).toBe('original\n')

    // The source session holds no undo: the record went to the child.
    const wrongPlace = await service.redo(agent)
    expect(wrongPlace.ok).toBe(false)

    const child = sessionAt(rewound.value.child, workspace.path)
    const redone = await confirmRedo(service, agentOn(child))
    expect(redone.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('later work\n')
    expect(child.snapshotEvents().some(event => event.type.startsWith('filesnap/'))).toBe(false)
  })

  it('accepts a fork the caller already performed', async () => {
    const file = join(workspace.path, 'a.txt')
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    writeFileSync(file, 'original\n')
    await runTurn(session, 1, 'set it up', async () => { await service.capture(agent, 1) })
    await runTurn(session, 2, 'change it', async () => { await service.capture(agent, 2) })
    writeFileSync(file, 'changed\n')

    const outcome = await service.rewind(agent, '2', { kind: 'into', session: SessionId('session-b') })
    expect(outcome.ok).toBe(true)
    // The deployment's own fork was used; this plugin built none.
    expect(forked).toHaveLength(0)
    expect(outcome.ok && outcome.value.child).toBe('session-b')

    const child = sessionAt('session-b', workspace.path)
    expect((await confirmRedo(service, agentOn(child))).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('changed\n')
  })

  it('marks the conversation a rewind leaves, and unmarks it on the way back', async () => {
    // Rewind keeps the source visible. Completed redo can archive the child
    // when a host archive service is available and no undo records remain.
    const titles = new Map<string, string>([['session-a', 'add a rate limiter'], ['session-b', '↩ add a rate limiter (2)']])
    ctx.provide('sessionTitle', {
      get: (session: { id: string }) => {
        const title = titles.get(session.id)
        return title === undefined ? undefined : { title }
      },
      rename: (session: { id: string }, title: string) => {
        titles.set(session.id, title)
        return { title }
      },
    })

    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'original\n')
    const session = liveSessionAt(live, 'session-a', workspace.path)
    const agent = agentOn(session)
    await runTurn(session, 1, 'set it up', async () => { await service.capture(agent, 1) })
    await runTurn(session, 2, 'change it', async () => { await service.capture(agent, 2) })
    writeFileSync(file, 'changed\n')

    const child = liveSessionAt(live, 'session-b', workspace.path, 'session-a')
    const rewound = await service.rewind(agent, '2', { kind: 'into', session: SessionId('session-b') })
    expect(titles.get('session-b')).toBe('🟢 Active · add a rate limiter (2)')
    expect(rewound.ok).toBe(true)
    expect(rewound.ok && rewound.value.markedTitle).toBe('🔴 Inactive · add a rate limiter')
    expect(titles.get('session-a')).toBe('🔴 Inactive · add a rate limiter')

    // The redo runs in the fork, and hands back to the session it forked from.
    const redone = await confirmRedo(service, agentOn(child))
    expect(redone.ok).toBe(true)
    expect(redone.ok && redone.value.returnedTo).toBe('session-a')
    expect(titles.get('session-a')).toBe('🟢 Active · add a rate limiter')
    expect(titles.get('session-b')).toBe('🔴 Inactive · add a rate limiter (2)')
  })

  it('refuses a point nobody offered', async () => {
    const session = sessionAt('session-a', workspace.path)
    session.append('turn/start', { turn: 1 })
    await service.capture(agentOn(session), 1)
    const outcome = await service.rewind(agentOn(session), '99')
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.refusal).toEqual({ kind: 'unknown-point', point: '99' })
    expect(forked).toHaveLength(0)
  })

  it('refuses to rewind an agent that is mid-turn', async () => {
    const session = sessionAt('session-a', workspace.path)
    session.append('turn/start', { turn: 1 })
    await service.capture(agentOn(session), 1)
    const outcome = await service.rewind(agentOn(session, 'running'), '1')
    expect(!outcome.ok && outcome.refusal.kind).toBe('agent-busy')
    // Nothing was forked and nothing was written.
    expect(forked).toHaveLength(0)
  })

  it('declares a pre-image for a path the scan never sees, and restores it', async () => {
    const outside = scratch('filesnap-svc-outside')
    try {
      const file = join(outside.path, 'config.toml')
      writeFileSync(file, 'before\n')
      const session = sessionAt('session-a', workspace.path)
      const agent = agentOn(session)
      await runTurn(session, 1, 'look around', async () => { await service.capture(agent, 1) })
      await runTurn(session, 2, 'edit the config', async () => {
        await service.capture(agent, 2)
        await service.declare(agent, 2, [file])
        writeFileSync(file, 'after\n')
      })

      expect((await service.rewind(agent, '2')).ok).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('before\n')
    } finally {
      outside.remove()
    }
  })

  it('declares a created path so the rewind may remove it again', async () => {
    const created = join(workspace.path, 'new.txt')
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    await runTurn(session, 1, 'look around', async () => { await service.capture(agent, 1) })
    await runTurn(session, 2, 'add a file', async () => {
      await service.capture(agent, 2)
      await service.declare(agent, 2, [created])
      writeFileSync(created, 'brand new\n')
    })

    const outcome = await service.rewind(agent, '2')
    expect(outcome.ok && outcome.value.deleted).toBe(1)
    expect(existsSync(created)).toBe(false)
  })

  it('declares one path once per turn, however many times it is edited', async () => {
    // The engine ignores a repeat, so this is about not paying for the process.
    const file = join(workspace.path, 'a.txt')
    writeFileSync(file, 'v0\n')
    const session = sessionAt('session-a', workspace.path)
    const agent = agentOn(session)
    let spawns = 0
    const counting = nodeSubprocess()
    ctx.filesnap  // touch the service so the invoker is built against the original
    session.append('turn/start', { turn: 1 })
    await service.capture(agent, 1)
    const inner = counting.spawn.bind(counting)
    ;(ctx.subprocess as unknown as { spawn: typeof inner }).spawn = (spec) => {
      if (spec.argv.includes('declare')) spawns++
      return inner(spec)
    }
    await service.declare(agent, 1, [file])
    await service.declare(agent, 1, [file])
    await service.declare(agent, 1, [file, file])
    expect(spawns).toBe(1)
  })
})
