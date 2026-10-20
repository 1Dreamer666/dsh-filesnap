/** Persisted conversations must open in a fresh process without this plugin. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decodeArtifact, migrateFile } from '../src/migrate-session-logs.ts'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, Session, SessionLogOffset, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import * as JsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply } from '../src/index.ts'
import { MigrationManager } from '../src/migrations.ts'
import { carrySubagents, readStoredLog, listStoredSessions } from '../src/subagents.ts'
import type { SubagentCarryStore } from '../src/subagents.ts'
import { BINARY, nodeSubprocess, scratch } from './support.ts'

const JsonlSessionPersistence = ((JsonlModule as { default?: unknown }).default ?? JsonlModule) as Plugin<{ root: string }>

const READ_BACK = fileURLToPath(new URL('./support/read-back.mjs', import.meta.url))

interface ReadBack {
  ok: boolean
  message?: string
  types?: string[]
  filesnap?: { type: string; seq: number; ignorable?: true }[]
}

/** Open the session in a fresh harness process with no plugin mounted. */
function readBackWithoutPlugin(root: string, id: string): ReadBack {
  const run = spawnSync(process.execPath, [READ_BACK, root, id], { encoding: 'utf8', timeout: 60_000 })
  const line = run.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(line) as ReadBack
  } catch {
    throw new Error(`read-back produced no JSON (exit ${String(run.status)}):\n${run.stdout}\n${run.stderr}`)
  }
}

describe.skipIf(BINARY === undefined)('a log this plugin wrote, opened by a harness that never loaded it', () => {
  let workspace: ReturnType<typeof scratch>
  let store: ReturnType<typeof scratch>
  let root: ReturnType<typeof scratch>
  let ctx: Context
  let fibers: Awaited<ReturnType<Context['plugin']>>[]

  beforeEach(async () => {
    workspace = scratch('filesnap-persist-ws')
    store = scratch('filesnap-persist-store')
    root = scratch('filesnap-persist-logs')
    await mount()
  })

  async function mount(): Promise<void> {
    ctx = new Context()
    ctx.provide('subprocess', nodeSubprocess())
    ctx.provide('fs', { processPath: (target: { targetKey: string }) => target.targetKey })
    let initiator: Agent | undefined
    ctx.provide('agents', {
      currentInitiator: () => initiator,
      withInitiator: <T>(agent: Agent, operation: () => T): T => {
        const previous = initiator
        initiator = agent
        try { return operation() } finally { initiator = previous }
      },
      create: () => Promise.resolve({}),
    })
    fibers = []
    fibers.push(await ctx.plugin(SessionStore))
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: root.path }))
    fibers.push(await ctx.plugin(CommandRuntime))
    fibers.push(await ctx.plugin(
      { name: 'dsh-filesnap', apply },
      /* v8 ignore next -- the binary is required for this suite to run at all */
      { command: BINARY ?? '', dataDir: store.path, timeoutMs: 60_000 },
    ))
  }

  afterEach(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    workspace.remove()
    store.remove()
    root.remove()
  })

  /** A session created through the store, so persistence observes it. */
  function agentFor(id: string): Agent & { session: Session } {
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: workspace.path } })
    return {
      id: session.id,
      session,
      status: 'idle',
      options: { provider: 'mock', model: 'mock' },
    } as unknown as Agent & { session: Session }
  }

  /** Persist fixture sessions using each generation's actual ownership model. */
  async function persist(session: Session): Promise<void> {
    const backend = ctx.sessionPersistence as unknown as SubagentCarryStore
    if (typeof backend.open !== 'function') {
      await ctx.sessions.flush(session)
      return
    }
    // 0.2.x session controllers own handles explicitly; constructing a bare
    // SessionStore fixture does not acquire a writer on its behalf.
    const handle = await backend.create!(session.header, { inheritedEventCount: Number(session.inheritedEventCount) })
    try {
      await handle.append!(session.snapshotEvents())
      await handle.flush!()
    } finally {
      await handle.close()
    }
  }

  /** One turn, the way the harness drives it: pre-step first, so the plugin captures. */
  async function oneTurn(agent: Agent, turn: number): Promise<void> {
    agent.session.append('turn/start', { turn })
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn, step: 1, signal: new AbortController().signal },
      (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    agent.session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: `turn ${String(turn)}` }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    agent.session.append('step/start', { turn, step: 1 })
    agent.session.append(
      'assistant/message',
      {
        turn,
        step: 1,
        ...{ stream: [] },
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'done' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      },
      { surfaceOp: 'append' },
    )
    agent.session.append('step/end', { turn, step: 1 })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it('captures real snapshots yet opens without the plugin', async () => {
    const agent = agentFor('persist-declared')
    await oneTurn(agent, 1)
    expect(await ctx.filesnap.points(agent)).toMatchObject({ ok: true, value: [{ point: 'persist-declared.t1' }] })
    await persist(agent.session)

    // The real backend accepts the current native log without plugin events.
    const here = await readStoredLog(ctx.sessionPersistence as unknown as SubagentCarryStore, SessionId('persist-declared'), undefined)
    expect(here.events.some(event => event.type.startsWith('filesnap/'))).toBe(false)

    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()

    // A fresh process with only native services must accept the same bytes.
    const elsewhere = readBackWithoutPlugin(root.path, 'persist-declared')
    expect(elsewhere.ok, elsewhere.message).toBe(true)
  })

  it('resolves inherited points through a real cold ancestor after restarting the host', async () => {
    const agent = agentFor('cold-source')
    await oneTurn(agent, 1)
    const boundary = agent.session.snapshotEvents().at(-1)!.seq
    await oneTurn(agent, 2)
    const branch = ctx.sessions.fork(agent.session, boundary, SessionId('cold-branch'))
    await persist(agent.session)
    await persist(branch)
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    await mount()
    expect(ctx.sessions.get(agent.session.id)).toBeUndefined()
    const saved = await readStoredLog(ctx.sessionPersistence as unknown as SubagentCarryStore, branch.id, undefined)
    const restored = Session.fromRestore(saved.header.id, saved.events, saved.header, SessionLogOffset(saved.inheritedEventCount))
    expect(await ctx.filesnap.points({ ...agent, id: restored.id, session: restored } as Agent)).toMatchObject({
      ok: true, value: [{ point: 'cold-source.t1', turn: 1 }],
    })
  })

  it('persists distinct carried siblings across rewinds and opens the clones without the plugin', async () => {
    const source = agentFor('carry-source').session
    source.append('turn/start', { turn: 1 })
    const createdAt = Date.now()
    const children = ['carry-child-a', 'carry-child-b'].map(id => {
      const child = ctx.sessions.create(SessionId(id), { meta: {
        cwd: workspace.path, parentSession: source.id, origin: 'subagent', createdAt,
      } })
      child.append('turn/start', { turn: 1 })
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return child
    })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (const session of [source, ...children]) await persist(session)
    const branch = ctx.sessions.fork(source, undefined, SessionId('carry-branch'))
    const warnings: string[] = []
    const options = {
      branch, source,
      store: ctx.sessionPersistence as unknown as SubagentCarryStore,
      vocabulary: KNOWN_SESSION_EVENT_TYPES,
      warn: (message: string) => { warnings.push(message) },
    }
    expect(await carrySubagents(options)).toBe(2)
    const clones = (await listStoredSessions(options.store)).map(row => row.header).filter(header => header.parentSession === branch.id)
    expect(clones).toHaveLength(2)
    for (const header of clones) {
      const loaded = await readStoredLog(options.store, header.id, undefined)
      expect(loaded.header.id).toBe(header.id)
      expect(children.map(child => child.snapshotEvents())).toContainEqual(loaded.events.slice(0, 2))
      expect(loaded.inheritedEventCount).toBe(2)
    }
    // Re-read the real persisted headers, rather than an in-memory clone map.
    expect(await carrySubagents(options)).toBe(0)
    branch.append('turn/start', { turn: 2 })
    branch.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const next = ctx.sessions.fork(branch, undefined, SessionId('carry-next'))
    expect(await carrySubagents({ ...options, branch: next, source: branch })).toBe(2)
    const nextClones = (await listStoredSessions(options.store)).map(row => row.header).filter(header => header.parentSession === next.id)
    expect(nextClones).toHaveLength(2)
    for (const child of children) {
      expect((await readStoredLog(options.store, child.id, undefined)).events).toEqual(child.snapshotEvents())
    }
    expect(warnings).toEqual([])
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    for (const header of [...clones, ...nextClones]) {
      const loaded = readBackWithoutPlugin(root.path, header.id)
      expect(loaded.ok, loaded.message).toBe(true)
      expect(loaded.filesnap).toEqual([])
      expect(loaded.types).toContain('session/end-seed')
    }
  })

  it('finds and repairs a historical artifact through the real backend listing and locator', async () => {
    const header = { version: SESSION_FORMAT_VERSION, id: SessionId('historical-artifact'), createdAt: 1000, cwd: workspace.path, isSeeded: false }
    const backend = ctx.sessionPersistence as unknown as SubagentCarryStore
    const target = backend.locate!(header)!.path
    const path = join(dirname(target), 'session.jsonl.zstd')
    mkdirSync(dirname(path), { recursive: true })
    const rawHeader = { type: 'session', version: 0, id: header.id, createdAt: header.createdAt, cwd: header.cwd, delegationDepth: 0 }
    const event = { type: 'filesnap/point', seq: 0, time: 1001, data: { turn: 1, point: 'historical-artifact.t1' } }
    const original = Buffer.concat([
      zstdCompressSync(Buffer.from(JSON.stringify(rawHeader) + '\n')),
      zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')),
    ])
    writeFileSync(path, original)
    const manager = new MigrationManager(ctx)
    const plan = await manager.scan('legacy-session-events-v1')
    expect(plan.entries).toMatchObject([{ session: header.id, state: 'ready', events: 1 }])
    const report = await manager.execute(plan.token)
    expect(report.entries).toMatchObject([{ session: header.id, state: 'migrated' }])
    expect(readFileSync(report.entries[0]!.backup!)).toEqual(original)
    expect(decodeArtifact(readFileSync(path), true)).toContain('"ignorable":true')
  })

  // This repair targets native v0 artifacts; current formats are deliberately
  // outside its scope (the migration scanner tests cover their exclusion).
  it.skipIf(Number(SESSION_FORMAT_VERSION) !== 0)('repairs an old required event so a fresh reader can open the same log without the plugin', async () => {
    const agent = agentFor('legacy-repair')
    await oneTurn(agent, 1)
    await persist(agent.session)
    const path = (ctx.sessionPersistence as unknown as SubagentCarryStore).locate!(agent.session.header)!.path
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    const compressed = path.endsWith('.zstd')
    const original = readFileSync(path)
    const raw = decodeArtifact(original, compressed)
    const rows = raw.trimEnd().split('\n')
    const last = JSON.parse(rows.at(-1)!) as { seq: number; time: number }
    const old = raw + JSON.stringify({ type: 'filesnap/point', seq: last.seq + 1, time: last.time + 1, data: { point: 'legacy-repair.t1', turn: 1 } }) + '\n'
    const split = old.indexOf('\n') + 1
    writeFileSync(path, compressed ? Buffer.concat([zstdCompressSync(Buffer.from(old.slice(0, split))), zstdCompressSync(Buffer.from(old.slice(split)))]) : old)
    expect(readBackWithoutPlugin(root.path, 'legacy-repair').ok).toBe(false)
    const repaired = await migrateFile(path, true)
    expect(repaired.events).toBe(1)
    const loaded = readBackWithoutPlugin(root.path, 'legacy-repair')
    expect(loaded.ok, loaded.message).toBe(true)
    expect(loaded.types).toContain('user/message')
    expect(loaded.types).toContain('assistant/message')
  })

  it('a log with no plugin events opens anywhere, so the refusal is about these events alone', async () => {
    const session = ctx.sessions.create(SessionId('persist-plain'), { meta: { cwd: workspace.path } })
    session.append('turn/start', { turn: 1 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'assistant/message',
      { turn: 1, step: 1, ...{ stream: [] }, message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'mock', model: 'mock' } }) },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await persist(session)
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()

    const elsewhere = readBackWithoutPlugin(root.path, 'persist-plain')
    expect(elsewhere.ok, elsewhere.message).toBe(true)
    expect(elsewhere.types).toContain('assistant/message')
  })
})
