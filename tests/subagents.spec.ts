/**
 * Carrying a rewound session's children into the branch the rewind forked into.
 *
 * The module is driven directly, with real `Session` objects and fake
 * persistence in both backend generations. The harness linked for tests is
 * the older one — its event vocabulary has no `subagent/catalog` — so the
 * no-catalog-write behaviour a deployment under it needs is a first-class
 * case here, not a skipped one. The newer generation is exercised by passing
 * the vocabulary it composes.
 */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { carrySubagents, listStoredSessions, readStoredLog } from '../src/subagents.ts'
import type { SubagentCarryStore } from '../src/subagents.ts'

const CATALOG = 'subagent/catalog'
const DESCRIPTOR = 'subagent/descriptor'
const END_SEED = 'session/end-seed'

/** One deterministic epoch base for every fixture timestamp. */
const T0 = 1_700_000_000_000

/** The vocabulary the newer runtime composes. */
const CURRENT_VOCABULARY: ReadonlySet<string> = new Set([CATALOG, DESCRIPTOR])

/** The vocabulary a runtime predating the catalog composes. */
const LEGACY_VOCABULARY: ReadonlySet<string> = new Set([DESCRIPTOR])

/** One event envelope with the fields the harness validates; `seq` is the position, `time` defaults to one tick per event from {@link T0}. */
function log(...specs: readonly { type: string; data?: unknown; time?: number }[]): SessionEvent[] {
  return specs.map((spec, index) => ({
    type: spec.type,
    seq: SessionSeq(index),
    time: spec.time ?? T0 + index,
    data: spec.data ?? {},
  })) as unknown as SessionEvent[]
}

/** One catalog fact payload, shaped exactly as the harness writes it. */
function fact(childId: string, createdAt: number, mode: 'one-shot' | 'continuable' | 'unknown', label?: string): Record<string, unknown> {
  if (mode === 'unknown') return { version: 1, childId, childCreatedAt: createdAt, mode }
  return { version: 0, childId, childCreatedAt: createdAt, mode, ...label === undefined ? {} : { label } }
}

/** One child descriptor payload, shaped as the establishing provider writes it. */
function descriptor(mode: 'one-shot' | 'continuable', label?: string): Record<string, unknown> {
  return { version: 3, mode, provider: 'spawn', ...label === undefined ? {} : { label } }
}

/** A stored child header carrying every lineage field a clone copies. */
function childHeader(id: string, parent: string, createdAt: number): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    cwd: 'E:\\videos',
    parentSession: SessionId(parent),
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'standard',
  }
}

/** A live source session. */
function live(id: string): Session {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: T0,
    cwd: 'E:\\videos',
    isSeeded: false,
    agentPreset: 'standard',
  }
  return Session.create(SessionId(id), undefined, header)
}

/** The branch a rewind forked: a live session seeded with the retained history. */
function branchOf(id: string, source: Session, seed: readonly SessionEvent[]): Session {
  const header: SessionHeader = {
    ...source.header,
    id: SessionId(id),
    parentSession: source.header.id,
    isSeeded: true,
    createdAt: T0 + 1000,
  }
  return Session.create(SessionId(id), seed, header, SessionLogOffset(seed.length))
}

/** The envelope fields this suite reads off a log without narrowing the union. */
interface RawEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** The catalog fact payloads in one log, in order. */
function factsOf(events: readonly SessionEvent[]): Record<string, unknown>[] {
  return (events as readonly RawEvent[]).filter(event => event.type === CATALOG).map(event => event.data as Record<string, unknown>)
}

/** Append one catalog event through the widened face the plugin uses for plugin-owned events. */
function appendFact(session: Session, data: Record<string, unknown>): void {
  (session as unknown as { append(type: string, data: unknown): unknown }).append(CATALOG, data)
}

/** One session as a backend stores it. */
interface StoredSession {
  header: SessionHeader
  events: readonly SessionEvent[]
  inheritedEventCount: number
}

/** What a fake backend recorded while the carry ran. */
interface RecordedWrites {
  /** Records created through `create`; `events` is filled by the clone's append. */
  created: StoredSession[]
  /** Session ids read through `open`/`inspect`. */
  reads: string[]
  flushed: number
  closed: number
}

/** The 0.2.0 backend: header stats, read handles, and write handles handed out by `create`. */
function currentStore(seed: readonly StoredSession[]) {
  const stored = new Map(seed.map(session => [session.header.id as string, session]))
  const writes: RecordedWrites = { created: [], reads: [], flushed: 0, closed: 0 }
  const broken = new Set<string>()
  const store: SubagentCarryStore = {
    async stat(id) {
      const found = stored.get(id as string)
      return found === undefined ? undefined : { header: found.header }
    },
    async list() {
      return [...stored.values()].map(session => ({ header: session.header }))
    },
    async open(id) {
      const found = stored.get(id as string)
      if (found === undefined) throw new Error(`session "${id}" is not stored`)
      if (broken.has(id as string)) throw new Error(`session "${id}" cannot be opened`)
      writes.reads.push(id as string)
      return {
        header: found.header,
        inheritedEventCount: found.inheritedEventCount,
        async read() { return { events: found.events } },
        async close() { writes.closed += 1 },
      }
    },
    async create(header, options) {
      if (stored.has(header.id as string)) throw new Error(`session "${header.id}" already exists`)
      const record: StoredSession = { header, events: [], inheritedEventCount: options?.inheritedEventCount ?? 0 }
      stored.set(header.id as string, record)
      writes.created.push(record)
      return {
        inheritedEventCount: record.inheritedEventCount,
        async append(events) { record.events = events },
        async flush() { writes.flushed += 1 },
        async close() { writes.closed += 1 },
      }
    },
  }
  return { store, stored, writes, broken }
}

/** The 0.1.2 backend: raw header lists, `inspect`, and id-addressed `create`/`append`. */
function legacyStore(seed: readonly StoredSession[]) {
  const stored = new Map(seed.map(session => [session.header.id as string, session]))
  const writes: RecordedWrites = { created: [], reads: [], flushed: 0, closed: 0 }
  const broken = new Set<string>()
  // The 0.1.2 create signature and return value are the older generation's,
  // one cast away from the seam interface — the same cast the service makes.
  const store = {
    async list() {
      return [...stored.values()].map(session => session.header)
    },
    async inspect(id: string) {
      const found = stored.get(id as string)
      if (found === undefined) throw new Error(`session "${id}" is not stored`)
      if (broken.has(id as string)) throw new Error(`session "${id}" cannot be inspected`)
      writes.reads.push(id as string)
      return { meta: found.header, events: found.events, inheritedEventCount: found.inheritedEventCount }
    },
    async create(header: SessionHeader, inheritedEventCount?: number) {
      if (stored.has(header.id as string)) throw new Error(`session "${header.id}" already exists`)
      const record: StoredSession = { header, events: [], inheritedEventCount: inheritedEventCount ?? 0 }
      stored.set(header.id as string, record)
      writes.created.push(record)
    },
    async append(id: string, events: readonly SessionEvent[]) {
      const found = stored.get(id as string)
      if (found === undefined) throw new Error(`session "${id}" is not stored`)
      found.events = events
    },
  }
  return { store: store as unknown as SubagentCarryStore, stored, writes, broken }
}

describe('readStoredLog', () => {
  const child: StoredSession = {
    header: childHeader('child-9', 'parent-9', T0),
    events: log({ type: 'turn/start', data: { turn: 1 } }),
    inheritedEventCount: 1,
  }

  it('reads either generation back with its header, log and inherited cut', async () => {
    const legacy = await readStoredLog(legacyStore([child]).store, SessionId('child-9'), undefined)
    expect(legacy).toEqual({ header: child.header, events: child.events, inheritedEventCount: 1 })
    const current = await readStoredLog(currentStore([child]).store, SessionId('child-9'), undefined)
    expect(current).toEqual({ header: child.header, events: child.events, inheritedEventCount: 1 })
  })

  it('falls back to a header stat when the read handle states no header', async () => {
    const store: SubagentCarryStore = {
      async stat() { return { header: child.header } },
      async open() {
        return { inheritedEventCount: child.inheritedEventCount, async read() { return { events: child.events } }, async close() {} }
      },
    }
    expect(await readStoredLog(store, SessionId('child-9'), undefined))
      .toEqual({ header: child.header, events: child.events, inheritedEventCount: 1 })
  })

  it('closes the read handle even when the read itself fails', async () => {
    let closed = 0
    const store: SubagentCarryStore = {
      async open() {
        return {
          header: child.header,
          async read(): Promise<never> { throw new Error('the log cannot be read') },
          async close() { closed += 1 },
        }
      },
    }
    await expect(readStoredLog(store, SessionId('child-9'), undefined)).rejects.toThrow('the log cannot be read')
    expect(closed).toBe(1)
  })

  it('refuses a backend that exposes neither inspect nor open', async () => {
    await expect(readStoredLog({}, SessionId('child-9'), undefined)).rejects.toThrow('neither inspect nor open')
  })
})

describe('listStoredSessions', () => {
  const first = childHeader('child-a', 'parent-9', T0)
  const second = childHeader('child-b', 'parent-9', T0 + 1)

  it("unwraps 0.2.0 snapshots with the backend's format verdict", async () => {
    let options: unknown = 'unset'
    const store: SubagentCarryStore = {
      async open() { throw new Error('nothing opens a listing') },
      async list(received) {
        options = received
        return [
          { header: first, formatStatus: 'current', revision: 'r1', sizeBytes: 10 },
          { header: second, formatStatus: 'migration-required' },
        ]
      },
    }
    expect(await listStoredSessions(store)).toEqual([
      { header: first, formatStatus: 'current' },
      { header: second, formatStatus: 'migration-required' },
    ])
    expect(options).toEqual({})
  })

  it('passes 0.1.2 raw headers through and drops rows that carry none', async () => {
    const store: SubagentCarryStore = {
      async list() { return [first, { nope: 1 }, second] },
    }
    expect(await listStoredSessions(store, undefined)).toEqual([{ header: first }, { header: second }])
  })
})

describe('carrySubagents', () => {
  it('clones a named child under the branch and appends the fact that makes it visible', async () => {
    const source = live('source-root')
    const child: StoredSession = {
      header: childHeader('cadb60c2-7b75-4da6-a0d7-c6091d3622f7', 'source-root', T0 + 100),
      events: log(
        { type: DESCRIPTOR, data: descriptor('continuable', 'translate the subtitles') },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'continuable', 'stale label') },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([child])
    const warnings: string[] = []

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: message => { warnings.push(message) },
    })

    expect(warnings).toEqual([])
    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    const clone = backend.writes.created[0]!
    expect(clone.header.id).not.toBe(child.header.id)
    expect(clone.header.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(clone.header).toMatchObject({
      version: SESSION_FORMAT_VERSION,
      createdAt: child.header.createdAt,
      cwd: 'E:\\videos',
      parentSession: branch.header.id,
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'standard',
    })
    // The copied log is the clone's inherited prefix, closed by the cut
    // marker and reopened with the child's descriptor — the shape a seeded
    // child of the harness's own has, so every fold of the clone's history
    // starts at the cut.
    expect(clone.inheritedEventCount).toBe(child.events.length)
    expect(clone.events.slice(0, child.events.length)).toEqual(child.events)
    const suffix = (clone.events as readonly RawEvent[]).slice(child.events.length)
    expect(suffix.map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    expect(suffix[0]!.seq).toBe(child.events.length)
    expect(suffix[0]!.data).toEqual({ inherited: true })
    expect(suffix[1]!.data).toEqual(descriptor('continuable', 'translate the subtitles'))
    expect(backend.writes.flushed).toBe(1)
    // One close for the child's read handle, one for the clone's write handle.
    expect(backend.writes.closed).toBe(2)

    const appended = branch.snapshotEvents()
    const last = appended.at(-1)!
    expect(last.type).toBe(CATALOG)
    expect(last.seq).toBe(seed.length + 1)
    expect(last.data).toEqual({
      version: 0,
      childId: clone.header.id,
      childCreatedAt: child.header.createdAt,
      mode: 'continuable',
      // The child's own descriptor is authoritative, not the stale fact label.
      label: 'translate the subtitles',
    })
  })

  it('keeps the last fact per lineage stamp', async () => {
    const source = live('source-root')
    const older: StoredSession = {
      header: childHeader('older-child', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const newer: StoredSession = {
      header: childHeader('newer-child', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 2 } }),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: CATALOG, data: fact(older.header.id, older.header.createdAt, 'one-shot') },
      { type: CATALOG, data: fact(newer.header.id, newer.header.createdAt, 'one-shot') },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([older, newer])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    const clone = backend.writes.created[0]!
    expect(clone.events.slice(0, newer.events.length)).toEqual(newer.events)
    // No descriptor lives in the child's own suffix, so none is re-anchored.
    expect((clone.events as readonly RawEvent[]).slice(newer.events.length).map(event => event.type)).toEqual([END_SEED])
  })

  it('skips a lineage stamp the branch already carries in its own suffix', async () => {
    const source = live('source-root')
    const original: StoredSession = {
      header: childHeader('child-x', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const carried: StoredSession = {
      header: childHeader('child-x-clone', 'branch-1', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const seed = log({ type: CATALOG, data: fact(original.header.id, original.header.createdAt, 'one-shot') })
    const branch = branchOf('branch-1', source, seed)
    // A previous carry into this very branch left its own fact naming the clone.
    appendFact(branch, fact(carried.header.id, carried.header.createdAt, 'one-shot'))
    const backend = currentStore([original, carried])

    const carriedCount = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carriedCount).toBe(0)
    expect(backend.writes.created).toEqual([])
    // The prefix fact and the branch's own fact, and nothing new.
    expect(factsOf(branch.snapshotEvents())).toHaveLength(2)
  })

  it('falls back to stored lineage when the prefix names no facts', async () => {
    const source = live('source-root')
    const seed = log(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const branch = branchOf('branch-1', source, seed)
    const inside: StoredSession = {
      header: childHeader('inside-child', 'source-root', T0 + 1),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const after: StoredSession = {
      header: childHeader('after-child', 'source-root', T0 + 2),
      events: log({ type: 'turn/start', data: { turn: 2 } }),
      inheritedEventCount: 0,
    }
    // A sibling fork of the source: its parent matches, but it is not a child.
    const plain: StoredSession = {
      header: {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('plain-child'),
        createdAt: T0,
        cwd: 'E:\\videos',
        parentSession: source.header.id,
        isSeeded: false,
        agentPreset: 'standard',
      },
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const backend = legacyStore([inside, after, plain])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    expect(backend.writes.created[0]!.header.parentSession).toBe(branch.header.id)
    expect(backend.writes.created[0]!.events.slice(0, inside.events.length)).toEqual(inside.events)
    expect((backend.writes.created[0]!.events as readonly RawEvent[]).slice(inside.events.length).map(event => event.type)).toEqual([END_SEED])
    expect(factsOf(branch.snapshotEvents())).toHaveLength(1)
  })

  it('clones without writing catalog facts when the vocabulary lacks the type', async () => {
    const source = live('source-root')
    const child: StoredSession = {
      header: childHeader('child-1', 'source-root', T0 + 100),
      events: log({ type: DESCRIPTOR, data: descriptor('one-shot') }),
      inheritedEventCount: 0,
    }
    const seed = log({ type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'one-shot') })
    const branch = branchOf('branch-1', source, seed)
    const before = branch.snapshotEvents()
    const backend = legacyStore([child])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: LEGACY_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    // The seeded header and the cut marker are the clone's storage shape,
    // not catalog vocabulary: the older generation gets them too, with its
    // child's descriptor re-anchored past the cut.
    const clone = backend.writes.created[0]!
    expect(clone.header.isSeeded).toBe(true)
    expect(clone.events.slice(0, child.events.length)).toEqual(child.events)
    expect((clone.events as readonly RawEvent[]).slice(child.events.length).map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    expect((clone.events as readonly RawEvent[]).at(-1)!.data).toEqual(descriptor('one-shot'))
    expect(branch.snapshotEvents()).toEqual(before)
  })

  it('mirrors the established mode into the fresh fact and falls back to unknown', async () => {
    const source = live('source-root')
    const oneShot: StoredSession = {
      header: childHeader('one-shot-child', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const viaFact: StoredSession = {
      header: childHeader('fact-child', 'source-root', T0 + 200),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const unknown: StoredSession = {
      header: childHeader('unknown-child', 'source-root', T0 + 300),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const descriptorWins: StoredSession = {
      header: childHeader('descriptor-child', 'source-root', T0 + 400),
      events: log({ type: DESCRIPTOR, data: descriptor('one-shot', 'from descriptor') }),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: CATALOG, data: fact(oneShot.header.id, oneShot.header.createdAt, 'one-shot') },
      { type: CATALOG, data: fact(viaFact.header.id, viaFact.header.createdAt, 'continuable', 'from fact') },
      { type: CATALOG, data: fact(unknown.header.id, unknown.header.createdAt, 'unknown') },
      { type: CATALOG, data: fact(descriptorWins.header.id, descriptorWins.header.createdAt, 'continuable', 'stale') },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([oneShot, viaFact, unknown, descriptorWins])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(4)
    const [first, second, third, fourth] = backend.writes.created
    // The seed carries the original four facts; the clones' facts come after.
    const fresh = factsOf(branch.snapshotEvents()).slice(factsOf(seed).length)
    const payload = (index: number) => fresh.at(index)
    expect(payload(0)).toEqual({ version: 0, childId: first!.header.id, childCreatedAt: T0 + 100, mode: 'one-shot' })
    expect(payload(1)).toEqual({ version: 0, childId: second!.header.id, childCreatedAt: T0 + 200, mode: 'continuable', label: 'from fact' })
    expect(payload(2)).toEqual({ version: 1, childId: third!.header.id, childCreatedAt: T0 + 300, mode: 'unknown' })
    expect(payload(3)).toEqual({ version: 0, childId: fourth!.header.id, childCreatedAt: T0 + 400, mode: 'one-shot', label: 'from descriptor' })
  })

  it("carries a child's own children into the clone and names them from inside it", async () => {
    const source = live('source-root')
    const grandchild: StoredSession = {
      header: childHeader('grand-1', 'child-1', T0 + 150),
      events: log({ type: DESCRIPTOR, data: descriptor('continuable', 'deep work') }),
      inheritedEventCount: 0,
    }
    const child: StoredSession = {
      header: childHeader('child-1', 'source-root', T0 + 100),
      events: log(
        { type: DESCRIPTOR, data: descriptor('continuable', 'outer work') },
        { type: 'turn/start', data: { turn: 1 } },
        { type: CATALOG, data: fact(grandchild.header.id, grandchild.header.createdAt, 'continuable', 'stale') },
      ),
      inheritedEventCount: 0,
    }
    // The seed runs past the child's events, so the fixture's fork point
    // keeps the grandchild's fact inside the child's kept log.
    const seed = log(
      { type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'continuable', 'outer work') },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([child, grandchild])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(2)
    const grandClone = backend.writes.created[0]!
    const childClone = backend.writes.created[1]!
    expect(childClone.header.parentSession).toBe(branch.header.id)
    expect(grandClone.header.parentSession).toBe(childClone.header.id)
    expect(grandClone.events.slice(0, grandchild.events.length)).toEqual(grandchild.events)
    expect((grandClone.events as readonly RawEvent[]).slice(grandchild.events.length).map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    // The clone keeps the child's log as its inherited prefix and opens its
    // own suffix the way a seeded child's does: cut marker, the child's
    // descriptor re-anchored, then the descendants carried under it.
    expect(childClone.inheritedEventCount).toBe(child.events.length)
    expect(childClone.events.slice(0, child.events.length)).toEqual(child.events)
    const suffix = (childClone.events as readonly RawEvent[]).slice(child.events.length)
    expect(suffix.map(event => event.type)).toEqual([END_SEED, DESCRIPTOR, CATALOG])
    expect(suffix[0]!.data).toEqual({ inherited: true })
    expect(suffix[1]!.data).toEqual(descriptor('continuable', 'outer work'))
    expect(suffix[2]!.seq).toBe(child.events.length + 2)
    expect(suffix[2]!.data).toEqual({
      version: 0,
      childId: grandClone.header.id,
      childCreatedAt: grandchild.header.createdAt,
      mode: 'continuable',
      label: 'deep work',
    })
    // What the cut exists for: folding only the clone's own suffix — the
    // discipline every catalog and continuation fold uses — sees the carried
    // grandchild, while the child's original fact naming the pre-rewind
    // grandchild stays closed inside the inherited prefix.
    const own = (childClone.events as readonly RawEvent[]).filter(event => event.seq >= childClone.inheritedEventCount)
    expect(factsOf(own as unknown as readonly SessionEvent[]).map(payload => payload['childId'])).toEqual([grandClone.header.id])
    expect(factsOf(branch.snapshotEvents()).at(-1)).toMatchObject({ childId: childClone.header.id, mode: 'continuable', label: 'outer work' })
  })

  it('cuts a child at the fork point and leaves a descendant born after it behind', async () => {
    const source = live('source-root')
    const grandchild: StoredSession = {
      header: childHeader('grand-1', 'child-1', T0 + 500),
      events: log({ type: DESCRIPTOR, data: descriptor('continuable', 'born too late'), time: T0 + 500 }),
      inheritedEventCount: 0,
    }
    const child: StoredSession = {
      header: childHeader('child-1', 'source-root', T0 + 100),
      events: log(
        { type: DESCRIPTOR, data: descriptor('continuable', 'outer work'), time: T0 + 100 },
        { type: 'turn/start', data: { turn: 1 }, time: T0 + 101 },
        { type: CATALOG, data: fact(grandchild.header.id, grandchild.header.createdAt, 'continuable', 'stale'), time: T0 + 500 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 501 },
      ),
      inheritedEventCount: 0,
    }
    // The seed's last event is the fork point: it keeps the child's spawn and
    // the turn it was running, and cuts the grandchild's fact with everything
    // that followed.
    const seed = log(
      { type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'continuable', 'outer work') },
      { type: 'turn/start', data: { turn: 2 }, time: T0 + 200 },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([child, grandchild])
    const warnings: string[] = []

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: message => { warnings.push(message) },
    })

    expect(warnings).toEqual([])
    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    const clone = backend.writes.created[0]!
    // The clone's inherited prefix stops at the fork point — mid-turn, since
    // the turn's end lies beyond it — and the end-seed marker closes it.
    expect(clone.inheritedEventCount).toBe(2)
    expect(clone.events.slice(0, 2)).toEqual(child.events.slice(0, 2))
    expect((clone.events as readonly RawEvent[]).slice(2).map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    // The grandchild was never even read: the fact that names it did not
    // survive the cut.
    expect(backend.writes.reads).toEqual(['child-1'])
    expect(factsOf(branch.snapshotEvents()).slice(factsOf(seed).length)).toEqual([
      { version: 0, childId: clone.header.id, childCreatedAt: T0 + 100, mode: 'continuable', label: 'outer work' },
    ])
  })

  it('cuts a carried descendant at the same fork point, recursively', async () => {
    const source = live('source-root')
    const great: StoredSession = {
      header: childHeader('great-1', 'grand-1', T0 + 600),
      events: log({ type: DESCRIPTOR, data: descriptor('one-shot'), time: T0 + 600 }),
      inheritedEventCount: 0,
    }
    const grandchild: StoredSession = {
      header: childHeader('grand-1', 'child-1', T0 + 300),
      events: log(
        { type: DESCRIPTOR, data: descriptor('continuable', 'deep work'), time: T0 + 300 },
        { type: 'turn/start', data: { turn: 1 }, time: T0 + 301 },
        { type: CATALOG, data: fact(great.header.id, great.header.createdAt, 'one-shot'), time: T0 + 600 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: T0 + 601 },
      ),
      inheritedEventCount: 0,
    }
    const child: StoredSession = {
      header: childHeader('child-1', 'source-root', T0 + 100),
      events: log(
        { type: DESCRIPTOR, data: descriptor('continuable', 'outer work'), time: T0 + 100 },
        { type: 'turn/start', data: { turn: 1 }, time: T0 + 101 },
        { type: CATALOG, data: fact(grandchild.header.id, grandchild.header.createdAt, 'continuable', 'deep work'), time: T0 + 300 },
        { type: 'turn/start', data: { turn: 2 }, time: T0 + 301 },
      ),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'continuable', 'outer work') },
      { type: 'turn/start', data: { turn: 3 }, time: T0 + 400 },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([child, grandchild, great])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(2)
    const grandClone = backend.writes.created[0]!
    const childClone = backend.writes.created[1]!
    // The child lived entirely before the fork point: its whole log is kept.
    expect(childClone.inheritedEventCount).toBe(child.events.length)
    // The grandchild's fact survived the cut, so the grandchild is carried —
    // but its own clone is cut by the same fork point, so its later turn and
    // the great-grandchild's fact do not survive.
    expect(grandClone.header.parentSession).toBe(childClone.header.id)
    expect(grandClone.inheritedEventCount).toBe(2)
    expect(grandClone.events.slice(0, 2)).toEqual(grandchild.events.slice(0, 2))
    expect((grandClone.events as readonly RawEvent[]).slice(2).map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    const childSuffix = (childClone.events as readonly RawEvent[]).slice(childClone.inheritedEventCount)
    expect(childSuffix.map(event => event.type)).toEqual([END_SEED, DESCRIPTOR, CATALOG])
    expect(childSuffix[2]!.data).toMatchObject({ childId: grandClone.header.id, mode: 'continuable', label: 'deep work' })
    expect(backend.writes.reads).toEqual(['child-1', 'grand-1'])
    expect(factsOf(branch.snapshotEvents()).slice(factsOf(seed).length)).toHaveLength(1)
  })

  it('warns about a child with no history before the fork point', async () => {
    const source = live('source-root')
    const skewed: StoredSession = {
      header: childHeader('skewed-child', 'source-root', T0 + 900),
      events: log({ type: DESCRIPTOR, data: descriptor('one-shot'), time: T0 + 900 }),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: CATALOG, data: fact(skewed.header.id, skewed.header.createdAt, 'one-shot') },
      { type: 'turn/start', data: { turn: 1 }, time: T0 + 200 },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([skewed])
    const warnings: string[] = []

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: message => { warnings.push(message) },
    })

    expect(carried).toBe(0)
    expect(backend.writes.created).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('skewed-child')
    expect(warnings[0]).toContain('predate the rewind point')
  })

  it('warns about children that are gone or unreadable and carries the rest', async () => {
    const source = live('source-root')
    const alive: StoredSession = {
      header: childHeader('alive-child', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const unreadable: StoredSession = {
      header: childHeader('unreadable-child', 'source-root', T0 + 200),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const seed = log(
      { type: CATALOG, data: fact('missing-child', T0 + 50, 'one-shot') },
      { type: CATALOG, data: fact(unreadable.header.id, unreadable.header.createdAt, 'one-shot') },
      { type: CATALOG, data: fact(alive.header.id, alive.header.createdAt, 'one-shot') },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = currentStore([alive, unreadable])
    backend.broken.add('unreadable-child')
    const warnings: string[] = []

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: message => { warnings.push(message) },
    })

    expect(carried).toBe(1)
    expect(backend.writes.created).toHaveLength(1)
    expect(factsOf(branch.snapshotEvents()).slice(factsOf(seed).length)).toHaveLength(1)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('missing-child')
    expect(warnings[1]).toContain('unreadable-child')
  })

  it('carries through the older backend generation, re-marking a seeded cut', async () => {
    const source = live('source-root')
    const child: StoredSession = {
      header: { ...childHeader('child-1', 'source-root', T0 + 100), isSeeded: true },
      events: log(
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
        { type: DESCRIPTOR, data: descriptor('continuable', 'seeded child') },
        { type: 'turn/start', data: { turn: 2 } },
      ),
      inheritedEventCount: 2,
    }
    // The seed runs to the child's last event, so the fork point keeps the
    // child's whole log in the clone.
    const seed = log(
      { type: CATALOG, data: fact(child.header.id, child.header.createdAt, 'continuable', 'seeded child') },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
    )
    const branch = branchOf('branch-1', source, seed)
    const backend = legacyStore([child])

    const carried = await carrySubagents({
      branch,
      source,
      store: backend.store,
      vocabulary: CURRENT_VOCABULARY,
      warn: () => {},
    })

    expect(carried).toBe(1)
    expect(backend.writes.reads).toContain('child-1')
    expect(backend.writes.created).toHaveLength(1)
    // The clone's cut spans the whole copied log — the child's own cut
    // included — and the descriptor it re-anchors is the one the child's own
    // suffix folds.
    const clone = backend.writes.created[0]!
    expect(clone.inheritedEventCount).toBe(child.events.length)
    expect(clone.events.slice(0, child.events.length)).toEqual(child.events)
    expect((clone.events as readonly RawEvent[]).slice(child.events.length).map(event => event.type)).toEqual([END_SEED, DESCRIPTOR])
    expect((clone.events as readonly RawEvent[]).at(-1)!.data).toEqual(descriptor('continuable', 'seeded child'))
    expect(factsOf(branch.snapshotEvents()).slice(factsOf(seed).length)).toHaveLength(1)
  })

  it('does nothing when there is no backend or nothing was inherited', async () => {
    const source = live('source-root')
    const child: StoredSession = {
      header: childHeader('child-1', 'source-root', T0 + 100),
      events: log({ type: 'turn/start', data: { turn: 1 } }),
      inheritedEventCount: 0,
    }
    const backend = currentStore([child])
    // A branch that inherited nothing: there is no retained history to read.
    const bare = Session.create(SessionId('bare'), undefined, { ...source.header, id: SessionId('bare') })

    expect(await carrySubagents({ branch: bare, source, store: backend.store, vocabulary: CURRENT_VOCABULARY, warn: () => {} })).toBe(0)
    expect(await carrySubagents({ branch: bare, source, store: undefined, vocabulary: CURRENT_VOCABULARY, warn: () => {} })).toBe(0)
    expect(backend.writes.created).toEqual([])
  })
})
