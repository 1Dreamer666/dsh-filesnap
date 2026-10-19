/** Host sequencing for native conversation forks and file restoration.
 * New operations persist named rescue targets before applying files. Recovery
 * state and redo references live outside conversation artifacts; legacy engine
 * undo records remain readable for rewinds created before this workflow.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { RecoveryManager } from './recovery.ts'
import type { RewindPreview, RedoPreview, CleanupPreview, CleanupOutcome } from './wire.ts'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId, SessionLogOffset, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { registerCommands } from './commands.ts'
import type { FilesnapCli, FilesnapRun } from './cli.ts'
import { bundledBinary } from './binary.ts'
import { createFilesnapCli, hasNoRestore, eventsOfType, lastEvent, numberField, stringField } from './cli.ts'
import { explain, pointId, sessionId as admitSessionId } from './ids.ts'
import { mark, activate } from './mark.ts'
import { foldPoints, selectPoint } from './points.ts'
import { carrySubagents, readStoredLog } from './subagents.ts'
import type { SubagentCarryStore } from './subagents.ts'
import type { FilesnapStatus, RedoOutcome, RewindOutcome, RewindPoint, RewindRefusal, RewindResult } from './types.ts'
import { FALLBACK_COMMAND } from './config.ts'
import type { FilesnapConfig } from './config.ts'

/** Per-session bookkeeping, all of it recoverable from the log or the store. */
interface TrackState {
  /** The filesnap session id, or why this session cannot be tracked. */
  readonly binding: { readonly ok: true; readonly id: string; readonly cwd: string }
    | { readonly ok: false; readonly why: string }
  /** Turns confirmed in the engine index; resumed captures check that index first. */
  readonly captured: Set<number>
  /** Paths already declared, per turn, so one file edited twice is one spawn. */
  readonly declared: Map<number, Set<string>>
  readonly capturing: Map<number, Promise<void>>
}

/**
 * Where a rewind's conversation half comes from. The fork is the host's
 * business, and a deployment that already has a correct one — the web client's
 * own fork, which also attaches the child to its workspace — should use it
 * rather than have this plugin build a second.
 */
export type RewindDestination
  /** This plugin forks the conversation and creates the child agent. */
  = | { readonly kind: 'fork' }
    /** The caller already forked; file the undo record in this session. */
    | { readonly kind: 'into'; readonly session: SessionId }

declare module '@deepseek-ai/cordis' {
  interface Context {
    filesnap: FilesnapRewind
  }
}

/** Refuse with a reason rather than throwing; every caller has to render it. */
function refuse<T>(refusal: RewindRefusal): RewindResult<T> {
  return { ok: false, refusal }
}

/** The engine's own words when it could not do what was asked. */
function engineRefusal<T>(run: FilesnapRun, what: string): RewindResult<T> {
  const detail = run.stderr === '' ? `filesnap exited ${run.exit}` : run.stderr
  return refuse({ kind: 'engine', message: `${what}: ${detail}` })
}

/**
 * The turn currently open in a session.
 *
 * Read from the log rather than tracked in memory: a resumed session is mid
 * conversation the moment it loads, and a counter starting at zero would file
 * its next capture under a turn id an earlier one already holds.
 *
 * @param session - the session to read.
 * @returns the open turn's number, or 0 when no turn has opened.
 */
export function currentTurn(session: Session): number {
  const last = session.snapshotEvents().findLast(event => event.type === 'turn/start')
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Read the first human prompt of this turn without the list label's truncation. */
export function promptForTurn(session: Session, target: number): string | undefined {
  let turn: number | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn
    else if (event.type === 'turn/end') turn = undefined
    else if (turn === target && event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      return text === '' ? undefined : text
    }
  }
  return undefined
}

/** Per-file failures, named individually because a terminal list has no bound (filesnap D40). */
function failures(run: FilesnapRun): { path: string; error: string }[] {
  return eventsOfType(run, 'restore.failed').map(event => ({
    path: stringField(event, 'path', '<unnamed>'),
    error: stringField(event, 'error', 'unreported'),
  }))
}

/**
 * Rewind and redo over a filesnap store.
 *
 * Registered as `ctx.filesnap`. The command handlers and the browser half both
 * go through it, so the sequencing exists once.
 */
/**
 * Which preset a session actually runs: the last one it selected, or the one
 * its header was created with.
 *
 * Six lines rather than an import, because the harness has moved this twice —
 * it was `resolveSessionPreset` in `@deepseek-ai/dsh-agent-presets`, and is now
 * an `agentPreset` projection. The rule behind both is the same and has not
 * changed: a later selection wins, and the header is the floor. Reading the log
 * directly is the one form that resolves against a harness on either side of
 * that move, and this plugin's peer ranges admit both.
 *
 * @param source - the session to read.
 * @returns the preset id, or undefined when the deployment composes none.
 */
function sessionPreset(source: Session): string | undefined {
  const events = source.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // Widened before the comparison, not narrowed after it. `SessionEventMap`
    // only carries `agent-preset/selected` when the presets package is in the
    // compilation, and this plugin does not import it — a deployment that
    // composes no presets should not have to. Declaring the type here instead
    // would put a second owner on another package's event.
    const event = events[index] as { type: string; data?: { agentPreset?: unknown } } | undefined
    if (event?.type !== 'agent-preset/selected') continue
    const selected = event.data?.agentPreset
    if (typeof selected === 'string') return selected
  }
  return source.header.agentPreset
}

export class FilesnapRewind extends Service {
  /**
   * Cordis reads an array as the required set and holds the fiber PENDING until
   * every name resolves; the object form is a name-to-config map, not a
   * required/optional split. `fs` and `agentPresets` are deliberately absent —
   * both are read through `ctx.get` at the moment they are needed, so a
   * deployment without a filesystem seam or per-session presets still gets a
   * working service rather than a plugin that never loads.
   */
  static inject = ['subprocess', 'agents']

  /** Validated deployment configuration. */
  private readonly config: FilesnapConfig
  readonly recovery: RecoveryManager

  /** Per-session state, dropped with the session it belongs to. */
  private readonly tracked = new WeakMap<Session, TrackState>()
  private readonly previews = new WeakMap<Session, {
    preview: RewindPreview; fingerprint: string; expires: number
  }>()
  private readonly redoTokens = new WeakMap<Session, { token: string; fingerprint: string; turn: number; expires: number; managedTarget?: string }>()
  private readonly cleanupTokens = new WeakMap<Session, { token: string; expires: number }>()

  /** The invoker, built once the executable has been resolved. */
  private cli: Promise<FilesnapCli | { readonly unavailable: string }> | undefined

  constructor(ctx: Context, config: FilesnapConfig) {
    super(ctx, 'filesnap')
    this.config = config
    this.recovery = new RecoveryManager(config.dataDir)

    // **Registered here, on the service's own fiber.** An earlier version put
    // these on a `ctx.inject(['filesnap'], …)` child so they could not run
    // before the service existed. That child is disposed as soon as its
    // callback returns, and cordis unwinds a disposed fiber's effects — so the
    // listeners vanished, silently, and no turn was ever captured. A service
    // that registers its own listeners cannot drift out of step with itself.

    // After `next()`, so a step the deployment rejects does not pay for a scan
    // of the tree — and still before `step/start`, the model request, and every
    // tool the step goes on to call.
    ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'enter') await this.capture(agent, turn, signal)
      return decision
    })

    if (config.declareEdits) {
      // **`prepend`, and the whole feature depends on it.** Both of these are
      // single-slot decision waterfalls, and the deployment's own policy —
      // `dsh-fs-observation-policy`, which every assembly that mounts the
      // filesystem tool also mounts — takes the slot and deliberately does not
      // call `next()`. A profile patch layer applies after the bundle layers,
      // so this plugin's listener registers second and, appended, never ran at
      // all: every pre-edit image was silently missed.
      //
      // Prepending is safe precisely because this listener decides nothing. It
      // records and delegates, so the policy still returns the intent and still
      // owns the outcome; only the observation happens first, which is the one
      // ordering that matters — the pre-image has to be read before the write.
      const observe = { prepend: true } as const
      ctx.on('fs/write-intent', async (target, _actor, next): Promise<FsWriteIntent | undefined> => {
        await this.declareTarget(target)
        return next()
      }, observe)
      ctx.on('fs/edit-intent', async (target, _actor, next): Promise<{ version: FsVersion } | undefined> => {
        await this.declareTarget(target)
        return next()
      }, observe)
    }

    // Command availability follows plugin composition, and a headless run has
    // no registry at all. The service stays reachable either way.
    const commands = ctx.get('commands')
    if (commands !== undefined) registerCommands(commands, this)
  }

  /**
   * Add or remove the rewound mark on one session's title.
   *
   * **Only a live session can be retitled.** `sessionTitle.rename` takes the
   * exact live `Session` and refuses anything else, so a conversation the user
   * has closed cannot be marked or unmarked from here. That is reported rather
   * than swallowed: on the redo side it means the conversation being returned
   * to keeps a mark that no longer applies, and the user should be told which
   * one.
   *
   * Renaming pins the title — automatic generation stops for that session.
   * Accepted: the alternative is a mark an automatic regeneration silently
   * erases, which is a mark that cannot be relied on.
   *
   * @param session - the session to retitle, live or not.
   * @param apply - how the current title becomes the new one.
   * @returns the new title, or why it could not be set.
   */
  private retitle(session: Session | undefined, apply: (title: string) => string): string | undefined {
    if (session === undefined) return undefined
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) return undefined
    // `ctx.get`, not `ctx.sessions`: `sessions` is not in this plugin's
    // `inject`, and a property read for an undeclared service throws — which
    // leaves the constructor and takes the whole fiber down, silently.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined || sessions.get(session.id) !== session) return undefined
    const current = titles.get(session)?.title
    if (current === undefined) return undefined
    const next = apply(current)
    if (next === current) return current
    try {
      return titles.rename(session, next).title
    } catch (error: unknown) {
      this.warn(`filesnap: could not retitle session "${session.id}": ${String(error)}`)
      return undefined
    }
  }

  /**
   * Carry the rewound session's subagents into the branch its fork created.
   *
   * Only the branch can show them: the fork keeps the rewound session's
   * history as an inherited prefix, but the branching session's own catalog
   * does not count children established in that prefix, and a continuation is
   * authorized against a child's durable parent — which is still the
   * pre-rewind session. The carry clones each retained child under the branch
   * and names it there; `./subagents.ts` holds the discovery and the two
   * persistence generations it spans.
   *
   * **This never fails the rewind it is attached to.** Per-child failures are
   * reported through `warn`; a deployment with no live branch — a headless run
   * or a caller that forked in another process — simply has nothing to carry
   * into.
   *
   * @param agent - the agent standing in the session the rewind left.
   * @param branchId - the id of the live session the fork landed in.
   * @param signal - caller cancellation.
   */
  private async carryBranchSubagents(agent: Agent, branchId: SessionId, signal?: AbortSignal): Promise<void> {
    const branch = this.ctx.get('sessions')?.get(branchId)
    if (branch === undefined) return
    await carrySubagents({
      branch,
      source: agent.session,
      store: this.ctx.get('sessionPersistence') as unknown as SubagentCarryStore | undefined,
      vocabulary: KNOWN_SESSION_EVENT_TYPES,
      warn: message => { this.warn(`filesnap: ${message}`) },
      ...signal === undefined ? {} : { signal },
    })
  }

  /**
   * Report something a person may need to see.
   *
   * The logger is resolved through `ctx.get` rather than read as `ctx.logger`,
   * for the same reason the command registry is: cordis refuses a property
   * read for an undeclared service, and declaring the logger would hold this
   * fiber PENDING in an assembly that mounts none. Without one the line goes to
   * stderr, which is where prose belongs anyway.
   *
   * @param message - the line to report.
   */
  private warn(message: string): void {
    const logger = this.ctx.get('logger')
    if (logger === undefined) console.error(message)
    else logger.warn(message)
  }

  /**
   * Record one path's pre-edit state, if there is an agent to attribute it to.
   *
   * The filesystem waterfalls carry an opaque tool-execution context rather
   * than an agent, so the agent comes from the initiator scope the driver
   * established. A mutation with no initiator — a plugin writing on its own
   * account — is not part of any turn and is left alone.
   *
   * @param target - the resolved target about to change.
   */
  private async declareTarget(target: FsTarget): Promise<void> {
    let agent: Agent | undefined
    try {
      agent = this.ctx.agents.currentInitiator()
    } catch {
      // The registry is disposed, which means the tree is coming down. A
      // missing pre-image matters less than a teardown that throws out of a
      // file write.
      return
    }
    if (agent === undefined) return
    if (agent.session.header.cwd !== undefined) await this.recovery.assertReady(agent.session.header.cwd)
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    await this.declare(agent, currentTurn(agent.session), [fs.processPath(target)])
  }

  /**
   * Resolve the `filesnap` executable once, lazily.
   *
   * Lazily because a deployment that has not installed it should still load:
   * the plugin then refuses each operation with a sentence naming the missing
   * command, which is a better failure than a tree that will not boot.
   *
   * @returns the invoker, or why the command could not be reached.
   */
  private invoker(): Promise<FilesnapCli | { readonly unavailable: string }> {
    const started = this.cli ?? this.start()
    this.cli = started
    return started
  }

  /**
   * Start the one executable lookup this service ever performs.
   *
   * @returns the invoker, or why the command could not be reached.
   */
  private start(): Promise<FilesnapCli | { readonly unavailable: string }> {
    return this.locate()
      .then((executable): FilesnapCli | { unavailable: string } => createFilesnapCli(this.ctx, {
        executable,
        dataDir: this.config.dataDir,
        timeoutMs: this.config.timeoutMs,
        graceMs: this.config.graceMs,
        maxOutputBytes: this.config.maxOutputBytes,
      }))
      .catch((error: unknown) => ({
        unavailable: `the \`filesnap\` command could not be found (${String(error)}). `
          + 'It installs with this package, so this usually means the install is '
          + 'incomplete — reinstall the plugin, or set its `command` config to a path.',
      }))
  }

  /**
   * Resolve the command to run, nearest first.
   *
   * 1. What the deployment named, when it named one.
   * 2. The prebuilt binary installed beside this package — the ordinary case,
   *    and the reason nobody has to install anything by hand.
   * 3. A bare `filesnap` on the provider's own PATH. This is the branch that
   *    matters for a subprocess provider whose execution world is not this
   *    machine, where a local `node_modules` path resolves to nothing.
   *
   * Every candidate goes through `resolveExecutable`, which verifies an
   * absolute path in the provider's world rather than this process's — so a
   * bundled path that exists here but not there is rejected and falls through
   * rather than being spawned into a sandbox that cannot see it.
   *
   * @returns the canonical executable path.
   * @throws when no candidate resolves.
   */
  private async locate(): Promise<string> {
    const named = this.config.command
    if (named !== undefined) return await this.ctx.subprocess.resolveExecutable(named)
    const bundled = bundledBinary()
    if (bundled !== undefined) {
      try {
        return await this.ctx.subprocess.resolveExecutable(bundled)
      } catch {
        // Installed here, unreachable there. Fall through to the PATH lookup,
        // which is what a remote execution world can actually answer.
      }
    }
    return await this.ctx.subprocess.resolveExecutable(FALLBACK_COMMAND)
  }

  /**
   * The per-session binding and its caches.
   *
   * `captured` is checked against the engine index before capturing: this
   * process may have resumed a session that already captured twenty turns, and
   * recapturing them would file a second manifest under a turn id that already
   * resolves to the first.
   *
   * @param session - the session to look up.
   * @returns its tracking state, created on first use.
   */
  private stateFor(session: Session): TrackState {
    const existing = this.tracked.get(session)
    if (existing !== undefined) return existing

    const cwd = session.header.cwd
    const admitted = admitSessionId(session.id)
    const binding: TrackState['binding'] = cwd === undefined
      ? { ok: false, why: 'the session has no working directory, and filesnap partitions a store by workspace' }
      : admitted.ok
        ? { ok: true, id: admitted.id, cwd }
        : { ok: false, why: `filesnap refuses the session id "${session.id}" because ${explain(admitted.refusal)}` }

    const captured = new Set<number>()
    const state: TrackState = { binding, captured, declared: new Map(), capturing: new Map() }
    this.tracked.set(session, state)
    if (!binding.ok) {
      this.warn(`filesnap: session "${session.id}" is not being tracked — ${binding.why}`)
    }
    return state
  }

  /**
   * Capture the workspace as it stands at the start of one turn.
   *
   * Called from an awaited extension point on purpose: a capture that has not
   * finished when the first tool runs is a rewind point that is missing exactly
   * the files the turn is about to change. The cost is the scan's latency once
   * per turn, which is the same trade every per-turn snapshot makes.
   *
   * A failure is reported and swallowed. Refusing to run a turn because a
   * snapshot could not be taken would make an optional safety net into a
   * single point of failure for the whole product.
   *
   * @param agent - the agent whose turn is opening.
   * @param turn - the harness turn number.
   * @param signal - the turn's cancellation signal.
   */
  async capture(agent: Agent, turn: number, signal?: AbortSignal): Promise<void> {
    if (agent.session.header.cwd !== undefined) await this.recovery.assertReady(agent.session.header.cwd)
    const state = this.stateFor(agent.session)
    const pending = state.capturing.get(turn)
    if (pending !== undefined) return pending
    const work = this.captureOnce(agent, turn, signal).catch(error => {
      state.captured.delete(turn)
      this.warn(`filesnap: snapshot capture failed: ${String(error)}`)
    }).finally(() => { state.capturing.delete(turn) })
    state.capturing.set(turn, work)
    return work
  }

  private async captureOnce(agent: Agent, turn: number, signal?: AbortSignal): Promise<void> {
    const session = agent.session
    const state = this.stateFor(session)
    if (!state.binding.ok || state.captured.has(turn)) return
    const point = pointId(state.binding.id, turn)
    if (!point.ok) {
      this.warn(
        `filesnap: turn ${String(turn)} of "${session.id}" cannot be captured — `
        + `the point id would be refused because ${explain(point.refusal)}`,
      )
      return
    }
    const cli = await this.invoker()
    if ('unavailable' in cli) {
      this.warn(`filesnap: no capture for turn ${String(turn)} — ${cli.unavailable}`)
      return
    }
    const existing = await cli.run(['log', '--session', state.binding.id, '--cwd', state.binding.cwd], state.binding.cwd, signal)
    if (existing.exit !== 'ok') {
      this.warn('filesnap: cannot verify existing snapshots; capture skipped to preserve earlier files.')
      return
    }
    if (eventsOfType(existing, 'log.entry').some(event => stringField(event, 'turn', '') === point.id)) {
      state.captured.add(turn)
      return
    }
    // Marked before the await settles rather than after: a second pre-step for
    // the same turn (a retried step, a steering claim) must not start a second
    // scan of the same tree.
    state.captured.add(turn)
    const run = await cli.run(
      ['capture', '--session', state.binding.id, '--turn', point.id, '--cwd', state.binding.cwd],
      state.binding.cwd,
      signal,
    )
    if (run.exit !== 'ok') {
      state.captured.delete(turn)
      this.warn(`filesnap: capture of turn ${String(turn)} did not complete — ${run.stderr}`)
      return
    }
    const done = lastEvent(run, 'capture.done')
    if (done === undefined) {
      state.captured.delete(turn)
      this.warn(`filesnap: capture of turn ${String(turn)} reported no terminal event`)
      return
    }

  }

  /**
   * Record what paths hold **before** an edit changes them.
   *
   * The caller says what it is about to change and never what the file used to
   * contain: filesnap stats and reads each path itself, so the pre-image rests
   * on an observation rather than a claim (filesnap D30). The cost of that
   * design is that calling late is silently wrong — declare after the write and
   * the stored "pre-image" is the post-edit content, with nothing to tell them
   * apart. Every call site here is on a decision waterfall that runs before the
   * provider mutates anything.
   *
   * @param agent - the agent whose turn owns the edit.
   * @param turn - the harness turn number.
   * @param paths - absolute paths about to change.
   * @param signal - the tool call's cancellation signal.
   */
  async declare(agent: Agent, turn: number, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    const state = this.stateFor(agent.session)
    if (!state.binding.ok || paths.length === 0) return
    const seen = state.declared.get(turn) ?? new Set<string>()
    state.declared.set(turn, seen)
    // A path already declared this turn is already in the manifest, so a second
    // call would be a no-op inside the engine — but it would still be a
    // process. One turn that edits one file twenty times stays one spawn.
    const fresh = paths.filter(path => !seen.has(path))
    if (fresh.length === 0) return
    const point = pointId(state.binding.id, turn)
    if (!point.ok) return
    const cli = await this.invoker()
    if ('unavailable' in cli) return
    for (const path of fresh) seen.add(path)
    const run = await cli.run(
      [
        'declare', '--session', state.binding.id, '--turn', point.id,
        '--cwd', state.binding.cwd,
        ...fresh.flatMap(path => ['--path', path]),
      ],
      state.binding.cwd,
      signal,
    )
    if (run.exit !== 'ok') {
      // Forget them, so the next edit of the same file tries again. The
      // pre-image is the one thing that cannot be recovered later.
      for (const path of fresh) seen.delete(path)
      this.warn(`filesnap: could not record pre-edit state for ${fresh.join(', ')} — ${run.stderr}`)
    }
  }

  /**
   * The points this session can be rewound to, newest last.
   *
   * Folded from the log and then intersected with what the store still holds,
   * because the two drift for ordinary reasons — `filesnap delete` ends a
   * session's data, and a store in a format this build does not understand is
   * refused rather than misread.
   *
   * @param agent - the agent whose session is being listed.
   * @param signal - caller cancellation.
   * @returns the available points, or why there are none to offer.
   */
  async points(agent: Agent, signal?: AbortSignal): Promise<RewindResult<RewindPoint[]>> {
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })
    const turns = foldPoints(agent.session.snapshotEvents())
    let owners: Map<number, string>
    try { owners = await this.turnOwners(agent.session, signal) }
    catch (error) { return refuse({ kind: 'untracked', why: String(error) }) }
    const entries = new Map<string, Set<string>>()
    for (const owner of new Set(owners.values())) {
      const run = await cli.run(['log', '--session', owner, '--cwd', state.binding.cwd], state.binding.cwd, signal)
      if (run.exit !== 'ok') return engineRefusal(run, 'filesnap could not read snapshot references')
      entries.set(owner, new Set(eventsOfType(run, 'log.entry').map(event => stringField(event, 'turn', ''))))
    }
    const points: RewindPoint[] = []
    for (const turn of turns) {
      const owner = owners.get(turn.turn)
      if (owner === undefined) continue
      const id = pointId(owner, turn.turn)
      if (id.ok && entries.get(owner)?.has(id.id)) points.push({ ...turn, point: id.id })
    }
    return { ok: true, value: points }

  }

  /** Resolve snapshot owners from DSH's existing fork prefix, including cold ancestors. */
  private async turnOwners(session: Session, signal?: AbortSignal): Promise<Map<number, string>> {
    const seen = new Set<string>()
    const read = async (header: SessionHeader, events: readonly SessionEvent[], inherited: number): Promise<Map<number, string>> => {
      if (seen.has(header.id)) throw new Error('Invalid cyclic session lineage.')
      seen.add(header.id)
      let parent = new Map<number, string>()
      if (header.parentSession !== undefined && inherited > 0) {
        const live = this.ctx.get('sessions')?.get(header.parentSession)
        if (live !== undefined) parent = await read(live.header, live.snapshotEvents(), live.inheritedEventCount)
        else {
          const persistence = this.ctx.get('sessionPersistence')
          if (persistence === undefined) throw new Error('The parent conversation must be available to resolve inherited snapshots.')
          const source = await readStoredLog(persistence as unknown as SubagentCarryStore, header.parentSession, signal)
          parent = await read(source.header, source.events, source.inheritedEventCount)
        }
      }
      const result = new Map<number, string>()
      for (const [index, event] of events.entries()) {
        if (event.type !== 'turn/start') continue
        const owner = index < inherited ? parent.get(event.data.turn) : header.id
        if (owner !== undefined) result.set(event.data.turn, owner)
      }
      return result
    }
    return read(session.header, session.snapshotEvents(), session.inheritedEventCount)
  }

  /**
   * What the store holds for this workspace, and what it does not protect.
   *
   * **Re-scans.** The engine answers this by walking the tree again rather
   * than reading something a capture stored, because the question is about the
   * project as it stands now, not as it stood at some past turn. That is why
   * nothing calls this per turn: it costs what a capture costs.
   *
   * @param agent - the agent whose workspace is being asked about.
   * @param signal - caller cancellation.
   * @returns the workspace's protection and usage picture, or why it could not be read.
   */
  async status(agent: Agent, signal?: AbortSignal): Promise<RewindResult<FilesnapStatus>> {
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })

    const run = await cli.run(['status', '--cwd', state.binding.cwd], state.binding.cwd, signal)
    if (run.exit !== 'ok') return engineRefusal(run, 'filesnap could not read this workspace')

    const usage = lastEvent(run, 'status.usage')
    return {
      ok: true,
      value: {
        workspace: stringField(lastEvent(run, 'status.workspace'), 'workspace', state.binding.cwd),
        sessions: eventsOfType(run, 'status.session').map(event => ({
          session: stringField(event, 'session', ''),
          turns: numberField(event, 'turns', 0),
          earliest: stringField(event, 'earliest', ''),
          latest: stringField(event, 'latest', ''),
        })),
        recordsBytes: numberField(usage, 'recordsBytes', 0),
        sharedContentBytes: numberField(usage, 'sharedContentBytes', 0),
        unprotected: eventsOfType(run, 'status.unprotected').map(event => ({
          path: stringField(event, 'path', '<unnamed>'),
          reason: stringField(event, 'reason', 'unreported'),
        })),
      },
    }
  }

  /** Plan without forking or changing workspace files. Prepare saves a recovery checkpoint. */
  async preview(agent: Agent, selector: string, signal?: AbortSignal): Promise<RewindResult<RewindPreview>> {
    this.previews.delete(agent.session)
    const plan = await this.preparePreview(agent, selector, signal)
    if (!plan.ok) return plan
    const preview: RewindPreview = {
      token: randomUUID(), point: plan.value.point.point, turn: plan.value.point.turn,
      changes: plan.value.changes,
    }
    this.previews.set(agent.session, { preview, fingerprint: plan.value.fingerprint, expires: Date.now() + 300_000 })
    return { ok: true, value: preview }
  }

  /** Explain store-wide collection; the displayed sizes are usage, not reclaim estimates. */
  async previewCleanup(agent: Agent, signal?: AbortSignal): Promise<RewindResult<CleanupPreview>> {
    this.cleanupTokens.delete(agent.session)
    const status = await this.status(agent, signal)
    if (!status.ok) return status
    const token = randomUUID()
    this.cleanupTokens.set(agent.session, { token, expires: Date.now() + 300_000 })
    const { workspace, recordsBytes, sharedContentBytes } = status.value
    return { ok: true, value: { token, workspace, recordsBytes, sharedContentBytes } }
  }

  /** Reclaim unreferenced objects only; never delete sessions or retained recovery points. */
  async cleanup(agent: Agent, token: string, signal?: AbortSignal): Promise<RewindResult<CleanupOutcome>> {
    const saved = this.cleanupTokens.get(agent.session)
    this.cleanupTokens.delete(agent.session)
    if (saved?.token !== token || saved.expires < Date.now()) {
      return refuse({ kind: 'engine', message: 'Cleanup confirmation expired. Run /rewind cleanup again.' })
    }
    if (agent.status === 'running') return refuse({ kind: 'agent-busy' })
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })
    if ((await this.recovery.list()).length > 0) return refuse({ kind: 'engine', message: 'Resolve interrupted restores in FileSnap settings before cleaning snapshots.' })
    const run = await cli.run(['gc'], state.binding.cwd, signal)
    if (run.exit !== 'ok') return engineRefusal(run, 'Could not collect unreferenced snapshot data')
    const done = lastEvent(run, 'gc.done')
    const manifestsRemoved = numberField(done, 'manifestsRemoved', -1)
    const blobsRemoved = numberField(done, 'blobsRemoved', -1)
    if (run.refused !== 0 || !Number.isSafeInteger(manifestsRemoved) || !Number.isSafeInteger(blobsRemoved) || manifestsRemoved < 0 || blobsRemoved < 0) {
      return refuse({ kind: 'engine', message: 'Cleanup returned an incomplete result. Check snapshot status before retrying.' })
    }
    return { ok: true, value: { manifestsRemoved, blobsRemoved } }
  }

  private async preparePreview(agent: Agent, selector: string, signal?: AbortSignal): Promise<RewindResult<{
    point: RewindPoint; changes: RewindPreview['changes']; fingerprint: string
  }>> {
    if (agent.status === 'running') return refuse({ kind: 'agent-busy' })
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    const available = await this.points(agent, signal)
    if (!available.ok) return available
    const point = selectPoint(available.value, selector)
    if (point === undefined) return refuse({ kind: 'unknown-point', point: selector })
    if (point.boundary === undefined) return refuse({ kind: 'fork-failed', message: 'This point has no completed turn before it to fork from.' })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })
    const run = await cli.run([
      'prepare', '--session', state.binding.id, '--turn', `preview-${randomUUID()}`,
      '--target', point.point, '--cwd', state.binding.cwd,
    ], state.binding.cwd, signal)
    if (run.exit !== 'ok') return engineRefusal(run, 'Cannot preview the rewind (FileSnap 0.5.0+ is required)')
    const done = lastEvent(run, 'prepare.done')
    const changes: { path: string; action: 'write' | 'delete' }[] = []
    for (const event of eventsOfType(run, 'prepare.change')) {
      if (typeof event['path'] !== 'string' || (event['action'] !== 'write' && event['action'] !== 'delete')) {
        return refuse({ kind: 'engine', message: 'The engine returned an invalid file preview.' })
      }
      changes.push({ path: event['path'], action: event['action'] })
    }
    if (run.refused !== 0 || typeof done?.['manifest'] !== 'string' || typeof done['ignoreRules'] !== 'string'
      || done['writes'] !== changes.filter(change => change.action === 'write').length
      || done['deletes'] !== changes.filter(change => change.action === 'delete').length) {
      return refuse({ kind: 'engine', message: 'The file preview is incomplete; no rewind was performed.' })
    }
    return { ok: true, value: {
      point, changes,
      fingerprint: JSON.stringify([currentTurn(agent.session), done['manifest'], done['ignoreRules'], changes]),
    } }
  }

  /**
   * Put the workspace and the conversation back to one point.
   *
   * @param agent - the agent being rewound out of.
   * @param selector - a turn number as listed, or a point id verbatim.
   * @param destination - fork here, or file the undo record in a session the caller already forked.
   * @param signal - caller cancellation.
   * @returns what the rewind did, or why it did not happen.
   */
  async rewind(agent: Agent, selector: string, destination: RewindDestination = { kind: 'fork' }, signal?: AbortSignal, confirmation?: string): Promise<RewindResult<RewindOutcome>> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return refuse({ kind: 'untracked', why: 'This session has no workspace.' })
    try {
      await this.recovery.assertReady(cwd)
      return await this.recovery.exclusive(cwd, async () => {
        this.assertWorkspaceIdle(cwd)
        return this.rewindLocked(agent, selector, destination, signal, confirmation)
      })
    } catch (error) { return refuse({ kind: 'engine', message: String(error) }) }
  }

  private async rewindLocked(
    agent: Agent,
    selector: string,
    destination: RewindDestination = { kind: 'fork' },
    signal?: AbortSignal,
    confirmation?: string,
  ): Promise<RewindResult<RewindOutcome>> {
    let expected: string | undefined
    if (confirmation !== undefined) {
      const saved = this.previews.get(agent.session)
      this.previews.delete(agent.session)
      if (saved === undefined || saved.preview.token !== confirmation || saved.expires < Date.now()
        || (selector !== saved.preview.point && selector !== String(saved.preview.turn))) {
        return refuse({ kind: 'engine', message: 'The confirmation expired or belongs to another point. Preview the rewind again.' })
      }
      const fresh = await this.preparePreview(agent, selector, signal)
      if (!fresh.ok) return fresh
      expected = JSON.stringify((JSON.parse(fresh.value.fingerprint) as unknown[]).slice(1))
      if (fresh.value.fingerprint !== saved.fingerprint) {
        return refuse({ kind: 'engine', message: 'The workspace or ignore rules changed after preview. Preview the rewind again before confirming.' })
      }
    }
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    // A rewind while the agent is mid-turn would write over files the turn's
    // own tools are still using, and would fork a conversation whose last turn
    // has no end. Both halves need the agent standing still.
    if (agent.status === 'running') return refuse({ kind: 'agent-busy' })

    const available = await this.points(agent, signal)
    if (!available.ok) return available
    const point = selectPoint(available.value, selector)
    if (point === undefined) return refuse({ kind: 'unknown-point', point: selector })
    // Refused here rather than at the fork, because a caller that forked for
    // itself (`--into`) has already committed a child by the time this runs:
    // an anchorless point would have sent that fork to the host with no
    // `atSeq`, which silently means "the last completed turn" — the newest
    // state, the opposite of a rewind.
    const anchor = point.boundary
    if (anchor === undefined) {
      return refuse({
        kind: 'fork-failed',
        message: `turn ${String(point.turn)} has no completed turn before it to fork from`,
      })
    }

    const child = destination.kind === 'into'
      ? { ok: true as const, value: destination.session }
      : await this.forkConversation(agent, point, signal)
    if (!child.ok) return child

    const childBinding = admitSessionId(child.value)
    if (!childBinding.ok) {
      return refuse({
        kind: 'fork-failed',
        message: `the forked session id "${child.value}" cannot hold an undo record because ${explain(childBinding.refusal)}`,
      })
    }

    const cli = await this.invoker()
    /* v8 ignore next -- points() already refused an unavailable command */
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })
    const run = await this.recovery.begin(cli, realpathSync(state.binding.cwd), {
      kind: 'rewind', source: state.binding.id, destination: childBinding.id, target: point.point,
    }, signal, expected)
    // `partial` is a completed restore that could not write every file, and its
    // terminal event still carries the counts and the point it can be reversed
    // to. Treating it as a failure would discard the only record of what landed.
    if (run.exit !== 'ok' && run.exit !== 'partial') {
      return engineRefusal(run, `filesnap could not restore turn ${String(point.turn)}`)
    }
    const done = lastEvent(run, 'restore.done')
    if (done === undefined) return engineRefusal(run, 'the restore reported no terminal event')

    const written = numberField(done, 'written', 0)
    const deleted = numberField(done, 'deleted', 0)
    const failed = failures(run)
    const safety = stringField(done, 'safety', '')
    // The conversation being left now shares its whole history with the fork,
    // so mark it where the choice is made. Reversible on purpose — see mark.ts
    // for why this is not an archive.
    const marked = failed.length === 0 ? this.retitle(agent.session, mark) : undefined
    if (failed.length === 0) {
      this.retitle(this.ctx.get('sessions')?.get(child.value), activate)
      // Retained turns spawned subagents against the session being left; the
      // branch can neither show nor continue them until they are carried.
      await this.carryBranchSubagents(agent, child.value, signal)
    }

    const promptText = promptForTurn(agent.session, point.turn)
    const outcome: RewindOutcome = {
      ...promptText === undefined ? {} : { promptText },
      point,
      child: child.value,
      written,
      deleted,
      failures: failed,
      safety,
      ...marked === undefined ? {} : { markedTitle: marked },
    }
    return { ok: true, value: outcome }
  }

  /**
   * Reverse the rewind that landed in this session.
   *
   * The undo record is filed under the session a rewind switched *to*, which is
   * where the user is standing when they ask for it, and which no other session
   * can reach — so two conversations in one directory cannot consume each
   * other's undos.
   *
   * @param agent - the agent to reverse the rewind in.
   * @param signal - caller cancellation.
   * @returns what the undo did, or why it did not happen.
   */
  async previewRedo(agent: Agent, signal?: AbortSignal): Promise<RewindResult<RedoPreview>> {
    this.redoTokens.delete(agent.session)
    if (agent.status === 'running') return refuse({ kind: 'agent-busy' })
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })
    await this.recovery.assertReady(state.binding.cwd)
    const managed = await this.recovery.redoTarget(state.binding.cwd, state.binding.id)
    if (managed !== undefined && managed !== null) {
      const preview = await this.managedRedoPreview(cli, state.binding.cwd, state.binding.id, managed.turn, signal)
      const token = randomUUID()
      this.redoTokens.set(agent.session, { token, fingerprint: preview.fingerprint, managedTarget: managed.turn, turn: currentTurn(agent.session), expires: Date.now() + 300_000 })
      return { ok: true, value: { token, changes: preview.changes, returnedTo: managed.parent } }
    }
    const run = await cli.run(['undo', '--preview', '--session', state.binding.id, '--cwd', state.binding.cwd], state.binding.cwd, signal)
    if (hasNoRestore(run, state.binding.id)) return refuse({ kind: 'no-restore' })
    if (run.exit !== 'ok') {
      const unsupported = run.exit === 'usage' && /unexpected argument ['"]--preview['"]/u.test(run.stderr)
      return engineRefusal(run, unsupported ? 'This engine does not support redo preview; FileSnap 0.5.1+ is required' : 'Cannot preview redo')
    }
    const done = lastEvent(run, 'undo.preview')
    const changes: RedoPreview['changes'][number][] = []
    for (const event of eventsOfType(run, 'undo.change')) {
      if (typeof event['path'] !== 'string' || (event['action'] !== 'write' && event['action'] !== 'delete')) {
        return refuse({ kind: 'engine', message: 'The redo preview contains an invalid file change.' })
      }
      changes.push({ path: event['path'], action: event['action'] })
    }
    if (done === undefined || run.refused !== 0 || typeof done['fingerprint'] !== 'string' || !/^[a-f0-9]{64}$/u.test(done['fingerprint'])
      || done['writes'] !== changes.filter(change => change.action === 'write').length
      || done['deletes'] !== changes.filter(change => change.action === 'delete').length) {
      return refuse({ kind: 'engine', message: 'The redo preview is incomplete; no files were changed.' })
    }
    const token = randomUUID()
    this.redoTokens.set(agent.session, { token, fingerprint: done['fingerprint'], turn: currentTurn(agent.session), expires: Date.now() + 300_000 })
    return { ok: true, value: { token, changes, returnedTo: agent.session.header.parentSession } }
  }

  private assertWorkspaceIdle(cwd: string): void {
    const canonical = realpathSync(cwd)
    for (const agent of this.ctx.agents.list?.() ?? []) {
      if (agent.status !== 'running' || agent.session.header.cwd === undefined) continue
      if (realpathSync(agent.session.header.cwd) === canonical) throw new Error('Stop all agents using this workspace before restoring files.')
    }
  }

  async recoveryPreview(id: string, mode: 'apply' | 'rollback', signal?: AbortSignal) {
    const cli = await this.invoker()
    if ('unavailable' in cli) throw new Error(cli.unavailable)
    const item = (await this.recovery.list()).find(item => item.id === id)
    if (item !== undefined) this.assertWorkspaceIdle(item.cwd)
    return this.recovery.preview(cli, id, mode, signal)
  }

  async recover(token: string, signal?: AbortSignal) {
    const cli = await this.invoker()
    if ('unavailable' in cli) throw new Error(cli.unavailable)
    const item = await this.recovery.recover(cli, token, cwd => this.assertWorkspaceIdle(cwd), signal)
    const destination = item.phase === 'apply' ? item.destination : item.source
    const inactive = item.phase === 'apply' ? item.source : item.destination
    this.retitle(this.ctx.get('sessions')?.get(brandSessionId(destination)), activate)
    this.retitle(this.ctx.get('sessions')?.get(brandSessionId(inactive)), mark)
    return { ...item, openSession: destination }
  }

  private async managedRedoPreview(cli: FilesnapCli, cwd: string, session: string, target: string, signal?: AbortSignal) {
    const run = await cli.run(['prepare', '--session', session, '--turn', `preview-${randomUUID()}`, '--target', target, '--cwd', cwd], cwd, signal)
    const done = lastEvent(run, 'prepare.done')
    const changes = eventsOfType(run, 'prepare.change').map(row => ({ path: row['path'], action: row['action'] }))
    if (run.exit !== 'ok' || run.refused !== 0 || typeof done?.['manifest'] !== 'string' || typeof done['ignoreRules'] !== 'string'
      || changes.some(row => typeof row.path !== 'string' || (row.action !== 'write' && row.action !== 'delete'))
      || done['writes'] !== changes.filter(row => row.action === 'write').length || done['deletes'] !== changes.filter(row => row.action === 'delete').length) {
      throw new Error(run.stderr || 'Incomplete redo preview.')
    }
    return { changes: changes as RedoPreview['changes'], fingerprint: JSON.stringify([done['manifest'], done['ignoreRules'], changes]) }
  }

  async redo(agent: Agent, signal?: AbortSignal, token?: string): Promise<RewindResult<RedoOutcome>> {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return refuse({ kind: 'untracked', why: 'This session has no workspace.' })
    try {
      await this.recovery.assertReady(cwd)
      return await this.recovery.exclusive(cwd, async () => {
        this.assertWorkspaceIdle(cwd)
        return this.redoLocked(agent, signal, token)
      })
    } catch (error) { return refuse({ kind: 'engine', message: String(error) }) }
  }

  private async redoLocked(agent: Agent, signal?: AbortSignal, token?: string): Promise<RewindResult<RedoOutcome>> {
    const saved = this.redoTokens.get(agent.session)
    this.redoTokens.delete(agent.session)
    if (saved === undefined || saved.token !== token || saved.expires < Date.now() || saved.turn !== currentTurn(agent.session)) {
      return refuse({ kind: 'engine', message: 'Preview redo and confirm again; the confirmation is missing, expired or no longer matches this turn.' })
    }
    const state = this.stateFor(agent.session)
    if (!state.binding.ok) return refuse({ kind: 'untracked', why: state.binding.why })
    if (agent.status === 'running') return refuse({ kind: 'agent-busy' })
    const cli = await this.invoker()
    if ('unavailable' in cli) return refuse({ kind: 'untracked', why: cli.unavailable })

    let run: FilesnapRun
    if (saved.managedTarget !== undefined) {
      const managed = await this.recovery.redoTarget(state.binding.cwd, state.binding.id)
      if (!managed || managed.turn !== saved.managedTarget) return refuse({ kind: 'no-restore' })
      const fresh = await this.managedRedoPreview(cli, state.binding.cwd, state.binding.id, managed.turn, signal)
      if (fresh.fingerprint !== saved.fingerprint) return refuse({ kind: 'engine', message: 'The redo preview is stale. Preview again.' })
      run = await this.recovery.begin(cli, realpathSync(state.binding.cwd), {
        kind: 'redo', source: state.binding.id, destination: managed.parent, target: managed.turn,
      }, signal, saved.fingerprint)
    } else {
      run = await cli.run(['undo', '--session', state.binding.id, '--cwd', state.binding.cwd, '--expect', saved.fingerprint], state.binding.cwd, signal)
    }
    // `partial` here also covers a clean undo that found paths changed since
    // the rewind: they are reported, not refused, because the safety checkpoint
    // captured them before this wrote over them.
    if (run.exit !== 'ok' && run.exit !== 'partial') {
      if (hasNoRestore(run, state.binding.id)) return refuse({ kind: 'no-restore' })
      return engineRefusal(run, 'filesnap could not reverse the rewind')
    }
    const done = lastEvent(run, 'restore.done')
    if (done === undefined) return engineRefusal(run, 'the undo reported no terminal event')

    const conflicts = eventsOfType(run, 'undo.conflict').map(event => stringField(event, 'path', '<unnamed>'))
    const written = numberField(done, 'written', 0)
    const deleted = numberField(done, 'deleted', 0)
    const failed = failures(run)
    const safety = stringField(done, 'safety', '')
    // Symmetric with the rewind: the conversation being returned to loses its
    // mark, and the fork being left picks one up. The parent is the session the
    // rewind forked out of — a redo only resolves at all when a rewind filed
    // its undo record here, and that fork is what named this session.
    const parentId = agent.session.header.parentSession
    const restored = parentId === undefined || failed.length > 0
      ? undefined
      : this.retitle(this.ctx.get('sessions')?.get(parentId), activate)
    if (failed.length === 0) this.retitle(agent.session, mark)

    let archived = false
    let archiveError: string | undefined
    if (failed.length === 0 && parentId !== undefined) {
      // Undo records form a stack. Only hide a completed branch after the last
      // record has been consumed; never infer this from its title or ancestry.
      try {
        const remaining = await cli.run(['undo', '--preview', '--session', state.binding.id, '--cwd', state.binding.cwd], state.binding.cwd, signal)
        const managed = await this.recovery.redoTarget(state.binding.cwd, state.binding.id)
        if ((managed === null || managed === undefined) && hasNoRestore(remaining, state.binding.id)) {
          const registry = this.ctx.get('workspaceRegistry') as { archiveSession(id: SessionId): Promise<void> } | undefined
          if (typeof registry?.archiveSession === 'function') {
            await registry.archiveSession(agent.session.id)
            archived = true
          } else archiveError = 'This host does not provide session archiving.'
        } else if ((managed === null || managed === undefined) && remaining.exit !== 'ok') archiveError = 'Could not verify that the branch has no remaining undo records; it was kept visible.'
      } catch (error) { archiveError = String(error) }
    }

    return {
      ok: true,
      value: {
        written,
        deleted,
        failures: failed,
        safety,
        conflicts,
        archived,
        ...archiveError === undefined ? {} : { archiveError },
        ...parentId === undefined ? {} : { returnedTo: parentId },
        ...restored === undefined ? {} : { restoredTitle: restored },
      },
    }
  }

  /**
   * Fork the conversation at a point's boundary and publish an agent on it.
   *
   * Composition is inherited rather than chosen: the seeded history was
   * produced under the parent's preset and model route, and a child composed
   * differently would replay tool calls it can no longer make.
   *
   * @param agent - the source agent.
   * @param point - the point whose boundary the cut follows.
   * @param signal - creation-only cancellation.
   * @returns the child session id, or why the fork did not happen.
   */
  private async forkConversation(
    agent: Agent,
    point: RewindPoint,
    signal?: AbortSignal,
  ): Promise<RewindResult<SessionId>> {
    const source = agent.session
    const anchor = point.boundary
    if (anchor === undefined) {
      return refuse({
        kind: 'fork-failed',
        message: `turn ${String(point.turn)} has no turn before it to fork from`,
      })
    }
    // The same rule the host applies in `sessions.fork`, because the two paths
    // reach the same seam by different doors and a rewind must not mean one
    // thing from the browser and another from the command: the anchor names a
    // seq **inside** the last turn the fork keeps, and the cut runs through
    // that turn's `turn/end` and any standalone appends behind it.
    //
    // Located by index rather than by treating a seq as one. Chunk events do
    // not survive into the persisted log, so seq is sparse there, and the
    // arithmetic that works on a live array is silently wrong on a resumed one.
    const events = source.snapshotEvents()
    const endIndex = events.findIndex(event => event.type === 'turn/end' && event.seq >= anchor)
    if (endIndex === -1) {
      return refuse({
        kind: 'fork-failed',
        message: `the turn holding event ${String(anchor)} has not completed`,
      })
    }
    let cut = endIndex + 1
    while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
    const seed = events.slice(0, cut)
    const childId = brandSessionId(`session-${crypto.randomUUID()}`)
    const composition = await this.composition(source)
    try {
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: {
          ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
          parentSession: source.id,
          ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
        },
        agentOptions: agent.options,
        ...composition.setup === undefined ? {} : { setup: composition.setup },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return refuse({ kind: 'fork-failed', message: String(error) })
    }
    return { ok: true, value: childId }
  }

  /**
   * The child's scoped composition, when the deployment composes per session.
   *
   * `agentPresets` is optional, and its absence is the ordinary case for a
   * deployment that mounts one fixed agent. The dynamic import is reached only
   * once the service proves the package is installed.
   *
   * @param source - the session being forked.
   * @returns the preset id to record and the setup that mounts it.
   */
  private async composition(source: Session): Promise<{
    agentPreset?: string
    setup?: (agentCtx: Context) => Promise<void>
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return {}
    const resolved = await presets.resolve(sessionPreset(source))
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx: Context) => void await presets.mount(agentCtx, resolved.id),
    }
  }
}

export default FilesnapRewind

/** Re-exported so a consumer can name the log's own event shape. */
export type { SessionEvent }
