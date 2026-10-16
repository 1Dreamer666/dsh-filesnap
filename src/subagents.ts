/** Carry a rewound session's children into the branch its fork created.
 *
 * A fork keeps the rewound session's history as an inherited prefix, but the
 * branching session's subagent catalog only counts children established in
 * the branch's own suffix: facts from the inherited prefix are filtered out,
 * so the subagent panel of a fresh branch comes up empty even though the
 * turns the branch kept plainly spawned children — and there is no way to
 * continue them, because a continuation is authorized against the child's
 * durable parent, which is the pre-rewind session.
 *
 * This module walks the branch's inherited prefix, resolves every child it
 * names, and re-establishes each one under the branch as a clone: a fresh
 * session whose header keeps the child's identity fields but points at the
 * branch, and whose log copies the child's full stored log as an inherited
 * prefix. That prefix is closed exactly the way the harness closes its own
 * seeded children — a seeded header, an inherited-cut marker at the
 * boundary, then the child's descriptor re-anchored inside the clone's own
 * suffix — so the clone's descriptor, catalog, and continuation folds all
 * start where its inherited history ends, not at the copied log's start.
 * The clone is what the branch can then show and continue.
 *
 * Two runtime generations are spanned, because this plugin's supported
 * harness range is:
 *
 * - The 0.1.2 generation has no `subagent/catalog` vocabulary. Children are
 *   discovered by scanning stored headers for `origin: 'subagent'` sessions
 *   of the rewound session, and the carry writes the clones only — a fact
 *   appended to one of its logs would make the session unreadable to its own
 *   generation, so catalog writes are gated on the runtime vocabulary
 *   ({@link CarrySubagentsOptions.vocabulary}).
 * - The 0.2.0 generation writes catalog facts. A fact in the prefix names
 *   its child directly and keeps working after rewinds of rewinds — where
 *   the child's `parentSession` is an earlier session, not the one being
 *   rewound, which no header scan can infer — so facts are preferred. Each
 *   clone (and each descendant clone, recursively) receives a fresh fact
 *   under its new parent.
 *
 * Clones are written through whichever persistence generation the deployment
 * composes: the 0.2.0 handle API when `open` is present, the 0.1.2
 * `create`/`append` API otherwise. No failure here ever fails the rewind it
 * is attached to: a child that cannot be read, cloned, or named is warned
 * about, and the remaining children are carried.
 *
 * @module dsh-filesnap/subagents
 */

import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionId as brandSessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** The catalog event type of the 0.2.0 generation; absent from 0.1.2's vocabulary. */
const CATALOG_EVENT_TYPE = 'subagent/catalog'

/** The child descriptor event type both generations write. */
const DESCRIPTOR_EVENT_TYPE = 'subagent/descriptor'

/** The lifecycle event that closes a seeded session's inherited prefix. */
const END_SEED_EVENT_TYPE = 'session/end-seed'

/** The descriptor format the continuation machinery folds; older versions are not resumable. */
const DESCRIPTOR_VERSION = 3

/**
 * The slice of a per-session handle this module uses.
 *
 * The 0.2.0 backend hands out one handle per access mode; only the members
 * that mode needs exist at runtime, so they are all optional here and every
 * call site checks before calling.
 */
export interface SubagentCarryHandle {
  /** The open session's inherited prefix length; both access modes expose it. */
  readonly inheritedEventCount?: number
  /** Read a slice of the logical log; called once for the whole range. */
  read?(offset: number, length: number, options?: { readonly signal?: AbortSignal }): Promise<{ readonly events: readonly SessionEvent[] }>
  /** Append one contiguous batch. */
  append?(events: readonly SessionEvent[], options?: { readonly signal?: AbortSignal }): Promise<void>
  /** Durability barrier for appended events. */
  flush?(options?: { readonly signal?: AbortSignal }): Promise<void>
  /** Release the handle, and its write lease when it holds one. */
  close(): Promise<void>
}

/**
 * The structural persistence seam the carry uses, spanning both backend
 * generations this plugin supports. An instance of either is passed after a
 * cast; nothing beyond these members is touched.
 *
 * - {@link stat}, {@link open} and the handle API exist only on the 0.2.0
 *   generation, which this module detects through `typeof open`.
 * - {@link inspect} and {@link list} in its raw-header form are the 0.1.2
 *   generation's cold-read and listing surface.
 * - {@link create} exists in both with different signatures: 0.2.0's takes
 *   `{ inheritedEventCount }` and returns the owned write handle, while
 *   0.1.2's takes the cut positionally, returns nothing, and materializes
 *   through {@link append}. The 0.1.2 shape is reached by one cast where it
 *   is used.
 */
export interface SubagentCarryStore {
  /** 0.2.0: one stored header without reading its log. */
  readonly stat?: (id: SessionId, options?: { readonly signal?: AbortSignal }) => Promise<{ readonly header: SessionHeader } | undefined>
  /** Both: stored sessions, header-first (0.1.2 yields raw headers, 0.2.0 snapshots). */
  readonly list?: (signal?: AbortSignal | { readonly signal?: AbortSignal }) => Promise<readonly unknown[]>
  /** 0.1.2: validated header plus the whole log. */
  readonly inspect?: (id: SessionId, signal?: AbortSignal) => Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[]; readonly inheritedEventCount: number }>
  /** 0.2.0: open one session for `read` or `write`. */
  readonly open?: (id: SessionId, access: 'read' | 'write', options?: { readonly signal?: AbortSignal }) => Promise<SubagentCarryHandle>
  /** 0.2.0's create shape; see the interface note for the 0.1.2 divergence. */
  readonly create?: (header: SessionHeader, options?: { readonly signal?: AbortSignal; readonly inheritedEventCount?: number }) => Promise<SubagentCarryHandle>
  /** 0.1.2: append onto a session created through `create`. */
  readonly append?: (id: SessionId, events: readonly SessionEvent[]) => Promise<void>
}

/** Everything one carry needs: the branch, its source, storage, and the runtime vocabulary. */
export interface CarrySubagentsOptions {
  /** The live session the rewind landed in; its inherited prefix names the children. */
  readonly branch: Session
  /** The session the rewind left; the header-scan fallback looks for its children. */
  readonly source: Session
  /** The persistence backend, or `undefined` when the deployment mounts none. */
  readonly store: SubagentCarryStore | undefined
  /** The runtime's session-event vocabulary; catalog writes are gated on it. */
  readonly vocabulary: ReadonlySet<string>
  /** Report one child's failure. The carry continues, and the rewind is unaffected. */
  readonly warn: (message: string) => void
  /** Caller cancellation, observed between children. */
  readonly signal?: AbortSignal
}

/** One event envelope as this module reads it: the fixed fields, opaque payload. */
interface RawEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** One catalog fact, reduced to what a carry needs from it. */
interface CatalogEntry {
  readonly childId: SessionId
  readonly mode?: string
  readonly label?: string
}

/** One child to carry: where it lives now, and the fact that named it. */
interface Candidate {
  readonly childId: SessionId
  readonly header: SessionHeader
  readonly fact?: CatalogEntry
}

/** The established mode of a child, folded from its own descriptor. */
interface ChildDescriptor {
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
}

/** Everything one clone needs. */
interface CloneInput {
  readonly store: SubagentCarryStore
  readonly candidate: Candidate
  readonly parentId: SessionId
  /** Whether catalog facts may be written under this runtime's vocabulary. */
  readonly writable: boolean
  /** Originals already cloned in this carry, so a corrupt lineage cannot recurse. */
  readonly seen: Set<string>
  readonly warn: (message: string) => void
  readonly signal: AbortSignal | undefined
}

/** A written clone, with the fresh fact payload that names it. */
interface CloneResult {
  readonly cloneId: SessionId
  readonly payload: Record<string, unknown>
}

/**
 * Re-establish a rewound session's children under the branch it forked into.
 *
 * The branch's inherited prefix is the discovery source: every
 * `subagent/catalog` fact below the fork cut names a child that existed
 * before it. A prefix with no facts — a log written before the catalog
 * existed — falls back to stored `origin: 'subagent'` children of the
 * rewound session created no later than the last inherited event. Facts
 * whose session is gone, and clones whose write fails, are warned about and
 * skipped; everything else is carried.
 *
 * @param options - the branch, its source, storage, vocabulary and warnings.
 * @returns the number of children cloned into the branch.
 */
export async function carrySubagents(options: CarrySubagentsOptions): Promise<number> {
  const store = options.store
  if (store === undefined) return 0
  try {
    return await carry(options, store)
  } catch (error) {
    options.warn(`could not carry subagents into session "${options.branch.header.id}": ${String(error)}`)
    return 0
  }
}

/** The carry proper, behind the one place that guarantees it never throws. */
async function carry(options: CarrySubagentsOptions, store: SubagentCarryStore): Promise<number> {
  const { branch, source, vocabulary, warn, signal } = options
  const writable = vocabulary.has(CATALOG_EVENT_TYPE)
  const candidates = await candidatesFor(store, branch, source, signal, warn)
  const seen = new Set<string>()
  let carried = 0
  for (const candidate of candidates) {
    if (signal?.aborted === true) break
    try {
      const clone = await cloneChild({ store, candidate, parentId: branch.header.id, writable, seen, warn, signal })
      if (clone === undefined) continue
      if (writable) appendFactEvent(branch, clone.payload)
      carried += 1
    } catch (error) {
      warn(`subagent "${candidate.childId}" was not carried: ${String(error)}`)
    }
  }
  return carried
}

/** Discover the children the branch's retained history spawned. */
async function candidatesFor(
  store: SubagentCarryStore,
  branch: Session,
  source: Session,
  signal: AbortSignal | undefined,
  warn: (message: string) => void,
): Promise<Candidate[]> {
  const events = branch.snapshotEvents() as readonly RawEvent[]
  const cut = Number(branch.inheritedEventCount)
  const prefix = events.filter(event => event.seq < cut)
  const entries = entriesIn(prefix)
  if (entries.length > 0) {
    // Facts win: they name their child directly and survive rewinds of
    // rewinds. The branch's own suffix has the facts of children it was
    // already given — a re-used destination must not carry them twice.
    const resolved = new Set<string>()
    for (const entry of entriesIn(events.filter(event => event.seq >= cut))) {
      const header = await headerOf(store, entry.childId, signal)
      if (header !== undefined) resolved.add(stampOf(header))
    }
    const candidates = await resolve(store, entries, signal, warn)
    return candidates.filter(candidate => !resolved.has(stampOf(candidate.header)))
  }
  // No facts to read: a log written before the catalog existed. Children
  // are its stored subagent sessions created no later than the branch's
  // last retained event, minus whatever the branch already parents.
  const cutTime = prefix.at(-1)?.time
  if (cutTime === undefined || store.list === undefined) return []
  const headers = await listedHeaders(store, signal)
  const resolved = new Set<string>()
  const found: Candidate[] = []
  for (const header of headers.values()) {
    if (header.origin !== 'subagent') continue
    if (header.parentSession === branch.header.id) {
      resolved.add(stampOf(header))
      continue
    }
    if (header.parentSession === source.header.id && header.createdAt <= cutTime) {
      found.push({ childId: header.id, header })
    }
  }
  return lastPerStamp(found).filter(candidate => !resolved.has(stampOf(candidate.header)))
}

/** Turn fact entries into candidates, warning about children that are gone. */
async function resolve(
  store: SubagentCarryStore,
  entries: readonly CatalogEntry[],
  signal: AbortSignal | undefined,
  warn: (message: string) => void,
): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  for (const entry of entries) {
    let header: SessionHeader | undefined
    try {
      header = await headerOf(store, entry.childId, signal)
    } catch (error) {
      warn(`subagent "${entry.childId}" was not carried: ${String(error)}`)
      continue
    }
    if (header === undefined) {
      warn(`subagent "${entry.childId}" was not carried: its session is no longer stored`)
      continue
    }
    candidates.push({ childId: entry.childId, header, fact: entry })
  }
  return lastPerStamp(candidates)
}

/** Keep the last candidate per lineage stamp; a later fact supersedes its lineage's earlier ones. */
function lastPerStamp(candidates: readonly Candidate[]): Candidate[] {
  const kept = new Map<string, Candidate>()
  for (const candidate of candidates) kept.set(stampOf(candidate.header), candidate)
  return [...kept.values()]
}

/**
 * The lineage stamp that ties a session to its earlier selves across rewinds.
 *
 * Clones copy exactly these header fields, so an original, its clone, and
 * every later clone of that clone share one stamp — which is what keeps a
 * rewind of a rewind from carrying both an original and its clone, and what
 * makes a fact written by an earlier carry suppress the original it came
 * from.
 */
function stampOf(header: SessionHeader): string {
  return JSON.stringify([header.createdAt, header.cwd ?? null, header.agentPreset ?? null, header.delegationDepth ?? 0, header.origin ?? null])
}

/**
 * Clone one child — and, recursively, its own children — under a new parent.
 *
 * Descendants are cloned before the clone that will name them is written,
 * because a clone's own children are named from inside its log: the fresh
 * grandchild facts close the clone's own suffix, with the same contraction
 * discipline the branch itself gets. That suffix is opened the way the
 * harness opens a seeded child of its own — an inherited-cut marker at the
 * boundary, then the child's descriptor re-anchored inside the suffix —
 * because every fold of the clone's own history (catalog, descriptor,
 * continuation) starts at the cut, not at the copied log's start. A child
 * already seen in this carry is skipped rather than revisited, so a corrupt
 * lineage cannot recurse forever.
 *
 * @param input - the child, the parent it is re-attached to, and the carry context.
 * @returns the clone's identity and fresh fact payload, or `undefined` when it was already seen.
 */
async function cloneChild(input: CloneInput): Promise<CloneResult | undefined> {
  const { store, candidate, parentId, writable, seen, warn, signal } = input
  const key = candidate.childId as string
  if (seen.has(key)) return undefined
  seen.add(key)

  const saved = await readLog(store, candidate.childId, signal)
  const cloneId = brandSessionId(randomUUID())
  const descriptor = foldDescriptor(saved.events, saved.inheritedEventCount)
  const inheritedDescriptor = descriptorPayloadOf(saved.events, saved.inheritedEventCount)

  // The child's own suffix holds the facts of the children it spawned —
  // including, from an earlier carry, a previous generation of clones.
  // Keeping the last per stamp extends the newest lineage rather than an
  // original that is already represented.
  const own = saved.events.filter(event => event.seq >= saved.inheritedEventCount)
  const payloads: Record<string, unknown>[] = []
  for (const descendant of await resolve(store, entriesIn(own), signal, warn)) {
    try {
      const grand = await cloneChild({ store, candidate: descendant, parentId: cloneId, writable, seen, warn, signal })
      if (grand === undefined || !writable) continue
      payloads.push(grand.payload)
    } catch (error) {
      warn(`subagent "${descendant.childId}" was not carried: ${String(error)}`)
    }
  }

  const lineage = candidate.header
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: cloneId,
    createdAt: lineage.createdAt,
    ...lineage.cwd === undefined ? {} : { cwd: lineage.cwd },
    parentSession: parentId,
    isSeeded: true,
    origin: 'subagent',
    ...lineage.delegationDepth === undefined ? {} : { delegationDepth: lineage.delegationDepth },
    ...lineage.agentPreset === undefined ? {} : { agentPreset: lineage.agentPreset },
  }

  // The copied log is the clone's inherited prefix; the clone's own suffix
  // follows it in the harness's seeded-child shape.
  const cut = saved.events.length
  const suffix: RawEvent[] = [sessionEvent(END_SEED_EVENT_TYPE, cut, { inherited: true })]
  if (inheritedDescriptor !== undefined) {
    suffix.push(sessionEvent(DESCRIPTOR_EVENT_TYPE, cut + suffix.length, inheritedDescriptor))
  }
  for (const payload of payloads) suffix.push(factEvent(cut + suffix.length, payload))
  const batch = [...saved.events, ...suffix] as unknown as readonly SessionEvent[]

  if (typeof store.open === 'function') {
    if (store.create === undefined) throw new Error('the persistence backend exposes no create')
    const handle = await store.create(header, {
      ...signal === undefined ? {} : { signal },
      inheritedEventCount: SessionLogOffset(cut),
    })
    try {
      if (handle.append === undefined) throw new Error(`the write handle of session "${cloneId}" exposes no append`)
      await handle.append(batch, { ...signal === undefined ? {} : { signal } })
      if (handle.flush !== undefined) await handle.flush({ ...signal === undefined ? {} : { signal } })
    } finally {
      await handle.close()
    }
  } else {
    const legacyCreate = store.create as unknown as (header: SessionHeader, inheritedEventCount: SessionLogOffset) => Promise<unknown>
    if (typeof store.append !== 'function') throw new Error('the persistence backend exposes no append')
    await legacyCreate.call(store, header, SessionLogOffset(cut))
    await store.append(cloneId, batch)
  }

  return { cloneId, payload: freshFactPayload(cloneId, lineage.createdAt, descriptor, candidate.fact) }
}

/**
 * The fresh fact payload that names one clone.
 *
 * It mirrors what the harness itself writes when it establishes a child:
 * the clone's id and creation time, and the child's established mode. The
 * child's own descriptor wins over the original fact — it is what a
 * continuation folds — and a lineage with neither falls back to the
 * explicit unknown mode, which the newer runtime records as version 1.
 *
 * @param cloneId - the fresh session's id.
 * @param childCreatedAt - the clone's creation time (the original's).
 * @param descriptor - the child's own descriptor, when it folds to a supported one.
 * @param fact - the fact that named the original child, when there was one.
 * @returns the payload to append as a `subagent/catalog` event.
 */
function freshFactPayload(
  cloneId: SessionId,
  childCreatedAt: number,
  descriptor: ChildDescriptor | undefined,
  fact: CatalogEntry | undefined,
): Record<string, unknown> {
  const mode = descriptor?.mode ?? fact?.mode
  const label = descriptor?.label ?? fact?.label
  if (mode === 'continuable' && typeof label === 'string') {
    return { version: 0, childId: cloneId, childCreatedAt, mode: 'continuable', label }
  }
  if (mode === 'one-shot') {
    return { version: 0, childId: cloneId, childCreatedAt, mode: 'one-shot', ...typeof label === 'string' ? { label } : {} }
  }
  return { version: 1, childId: cloneId, childCreatedAt, mode: 'unknown' }
}

/**
 * Fold a persisted child log to its descriptor, as the continuation
 * machinery does: the first descriptor in the child's own suffix is
 * authoritative, and only the current version is understood. Anything else
 * — a missing descriptor, an older format, a malformed one — leaves the
 * fact's own record of the mode to speak.
 *
 * @param events - the child's complete log.
 * @param inheritedEventCount - the child's own fork cut.
 * @returns the established mode, or `undefined` when there is no usable descriptor.
 */
function foldDescriptor(events: readonly RawEvent[], inheritedEventCount: number): ChildDescriptor | undefined {
  for (const event of events) {
    if (event.seq < inheritedEventCount) continue
    if (event.type !== DESCRIPTOR_EVENT_TYPE) continue
    const data = asRecord(event.data)
    if (data?.['version'] !== DESCRIPTOR_VERSION) return undefined
    const mode = data['mode']
    const label = data['label']
    if (mode === 'one-shot') return { mode, ...typeof label === 'string' ? { label } : {} }
    if (mode === 'continuable' && typeof label === 'string') return { mode, label }
    return undefined
  }
  return undefined
}

/**
 * The raw payload of the first descriptor in a child's own suffix.
 *
 * A clone re-anchors this payload past its inherited cut, because the
 * continuation machinery folds a child's descriptor from its own suffix
 * only. The payload is copied verbatim: whatever the original folded to —
 * a supported descriptor, an older format, a malformed one — the clone
 * folds to the same.
 *
 * @param events - the child's complete log.
 * @param inheritedEventCount - the child's own fork cut.
 * @returns the descriptor payload, or `undefined` when the suffix has none.
 */
function descriptorPayloadOf(events: readonly RawEvent[], inheritedEventCount: number): unknown {
  for (const event of events) {
    if (event.seq < inheritedEventCount) continue
    if (event.type === DESCRIPTOR_EVENT_TYPE) return event.data
  }
  return undefined
}

/** Read one stored session's verbatim log and its inherited cut, through either generation. */
async function readLog(
  store: SubagentCarryStore,
  id: SessionId,
  signal: AbortSignal | undefined,
): Promise<{ readonly events: readonly RawEvent[]; readonly inheritedEventCount: number }> {
  if (typeof store.inspect === 'function') {
    const inspection = await store.inspect(id, signal)
    return {
      events: inspection.events as readonly RawEvent[],
      inheritedEventCount: Number(inspection.inheritedEventCount),
    }
  }
  if (typeof store.open === 'function') {
    const handle = await store.open(id, 'read', { ...signal === undefined ? {} : { signal } })
    try {
      if (handle.read === undefined) throw new Error(`the read handle of session "${id}" exposes no read`)
      const { events } = await handle.read(0, Number.MAX_SAFE_INTEGER, { ...signal === undefined ? {} : { signal } })
      return { events: events as readonly RawEvent[], inheritedEventCount: Number(handle.inheritedEventCount ?? 0) }
    } finally {
      await handle.close()
    }
  }
  throw new Error('the persistence backend exposes neither inspect nor open')
}

/** The header of one stored session, through the cheapest call this generation has. */
async function headerOf(store: SubagentCarryStore, id: SessionId, signal: AbortSignal | undefined): Promise<SessionHeader | undefined> {
  if (typeof store.stat === 'function') {
    const found = await store.stat(id, { ...signal === undefined ? {} : { signal } })
    return found?.header
  }
  return (await listedHeaders(store, signal)).get(id as string)
}

/** Every stored header, keyed by id. */
async function listedHeaders(store: SubagentCarryStore, signal: AbortSignal | undefined): Promise<Map<string, SessionHeader>> {
  const headers = new Map<string, SessionHeader>()
  if (store.list === undefined) return headers
  const rows = await store.list(typeof store.open === 'function' ? { ...signal === undefined ? {} : { signal } } : signal)
  for (const row of rows) {
    const header = rowHeader(row)
    if (header !== undefined) headers.set(header.id as string, header)
  }
  return headers
}

/** One listed row as a header; the 0.2.0 generation wraps headers in snapshots. */
function rowHeader(row: unknown): SessionHeader | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const header = (row as { header?: unknown }).header ?? row
  if (typeof header !== 'object' || header === null) return undefined
  return typeof (header as { id?: unknown }).id === 'string' ? header as SessionHeader : undefined
}

/** Every catalog fact in one slice of a log, in order. */
function entriesIn(events: readonly RawEvent[]): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const event of events) {
    const entry = catalogEntry(event)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/** Read one event as a catalog fact, or report that it is not a usable one. */
function catalogEntry(event: RawEvent): CatalogEntry | undefined {
  if (event.type !== CATALOG_EVENT_TYPE) return undefined
  const data = asRecord(event.data)
  const childId = data?.['childId']
  if (typeof childId !== 'string' || childId === '') return undefined
  const mode = data?.['mode']
  const label = data?.['label']
  return {
    childId: brandSessionId(childId),
    ...typeof mode === 'string' ? { mode } : {},
    ...typeof label === 'string' ? { label } : {},
  }
}

/** Object-shaped payload access; anything else is not a catalog fact or descriptor. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** One freshly minted plugin-owned event for a cold-written clone log. */
function sessionEvent(type: string, seq: number, data: unknown): RawEvent {
  return { type, seq: SessionSeq(seq), time: Date.now(), data }
}

/** One freshly minted catalog event for a cold-written clone log. */
function factEvent(seq: number, payload: Record<string, unknown>): RawEvent {
  return sessionEvent(CATALOG_EVENT_TYPE, seq, payload)
}

/** Append one catalog fact to the live branch, through the widened face plugin-owned events use. */
function appendFactEvent(session: Session, payload: Record<string, unknown>): void {
  const widened = session as unknown as { append(type: string, data: unknown): unknown }
  widened.append(CATALOG_EVENT_TYPE, payload)
}
