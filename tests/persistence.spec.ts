/** Persisted conversations must open in a fresh process without this plugin. */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { decodeArtifact, migrateFile } from '../src/migrate-session-logs.ts'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply } from '../src/index.ts'
import { BINARY, nodeSubprocess, scratch } from './support.ts'

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
    fibers = [
      await ctx.plugin(SessionStore),
      await ctx.plugin(JsonlSessionPersistence, { root: root.path }),
      await ctx.plugin(CommandRuntime),
      await ctx.plugin(
        { name: 'dsh-filesnap', apply },
        /* v8 ignore next -- the binary is required for this suite to run at all */
        { command: BINARY ?? '', dataDir: store.path, timeoutMs: 60_000 },
      ),
    ]
  })

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
    await ctx.sessions.flush(agent.session)

    // Same process, declaration present: the reader that refuses unknown
    // types accepts this one because the plugin added it at load.
    const here = await ctx.sessionPersistence.load(SessionId('persist-declared'))
    expect(here.events.some(event => event.type.startsWith('filesnap/'))).toBe(false)

    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()

    // Fresh process, plugin never loaded: the same bytes are refused, by
    // name, at the seq the point sits at. This is the message a user sees
    // after uninstalling, and under a source launch even with it installed.
    const elsewhere = readBackWithoutPlugin(root.path, 'persist-declared')
    expect(elsewhere.ok, elsewhere.message).toBe(true)
  })

  it('repairs an old required event so a fresh reader can open the same log without the plugin', async () => {
    const agent = agentFor('legacy-repair')
    await oneTurn(agent, 1)
    await ctx.sessions.flush(agent.session)
    const path = ctx.sessionPersistence.locate(agent.session.header)!.path
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
      { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'mock', model: 'mock' } }) },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()

    const elsewhere = readBackWithoutPlugin(root.path, 'persist-plain')
    expect(elsewhere.ok, elsewhere.message).toBe(true)
    expect(elsewhere.types).toContain('assistant/message')
  })
})
