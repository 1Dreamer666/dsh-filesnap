import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { decodeArtifact, migrateFile, repairArtifact, migrateStatusTitles } from '../src/migrate-session-logs.ts'
import { scratch } from './support.ts'

const header = { type: 'session', version: 0, id: 'legacy', createdAt: 1000, parentSession: 'parent', seedLength: 1, delegationDepth: 0 }
const rows = [
  { seq: 0, time: 1001, type: 'filesnap/point', data: { turn: 1, point: 'parent.t1' } },
  { seq: 1, time: 1002, type: 'filesnap/reply', data: { requestId: 'old' } },
  { seq: 2, time: 1003, type: 'user/message', surfaceOp: 'append', data: { content: '中文 remains verbatim' } },
  { seq: 3, time: 1004, type: 'other-plugin/required', data: {} },
]
const raw = [header, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n'
it.each([false, true])('repairs optional legacy envelopes without changing messages, seqs or fork metadata (compressed=%s)', async compressed => {
  const input = compressed ? Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n'))]) : Buffer.from(raw)
  const result = repairArtifact(input, compressed)
  expect(result.events).toBe(2)
  const repaired = decodeArtifact(result.bytes, compressed).trim().split('\n').map(s => JSON.parse(s))
  expect(repaired).toEqual([header, { ...rows[0], ignorable: true }, { ...rows[1], ignorable: true }, rows[2], rows[3]])
  expect(repairArtifact(result.bytes, compressed)).toEqual({ bytes: result.bytes, events: 0 })
  const dir = scratch('filesnap-migrate')
  try {
    const path = join(dir.path, compressed ? 'session.jsonl.zstd' : 'session.jsonl')
    writeFileSync(path, input)
    expect(await migrateFile(path)).toMatchObject({ events: 2 })
    expect(readFileSync(path)).toEqual(input)
    const written = await migrateFile(path, true)
    expect(readFileSync(written.backup!)).toEqual(input)
    expect(readFileSync(path)).toEqual(result.bytes)
  } finally { dir.remove() }
})
it('refuses future formats, incomplete tails, and surface-bearing custom events', () => {
  expect(() => repairArtifact(Buffer.from(raw.replace('"version":0', '"version":99')), false)).toThrow('Unsupported')
  expect(() => repairArtifact(Buffer.from(raw.trimEnd()), false)).toThrow('Incomplete')
  expect(() => repairArtifact(Buffer.from(raw.replace('"type":"filesnap/point"', '"type":"filesnap/point","surfaceOp":"append"')), false)).toThrow('Unexpected')
})

it('supports a versioned catalogue, skips loaded sessions, detects stale scans and is repeatable', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { MigrationManager, MIGRATIONS } = await import('../src/migrations.ts')
  const dir = scratch('filesnap-migration-manager')
  const path = join(dir.path, 'session.jsonl')
  const ctx = new Context()
  let loaded = true
  ctx.provide('sessions', { get: () => loaded ? {} : undefined })
  ctx.provide('sessionPersistence', {
    list: async () => [{ id: 'legacy' }],
    locate: () => ({ kind: 'jsonl', path }),
  })
  const manager = new MigrationManager(ctx, [...MIGRATIONS, {
    id: 'future-format-v2', from: '0.3.x', to: '0.4.x', name: 'Future test', nameZh: '未来版本测试',
    transform: bytes => ({ bytes, events: 0 }),
  }])
  try {
    writeFileSync(path, raw)
    expect(manager.catalogue().map(task => task.id)).toEqual(['legacy-session-events-v1', 'branch-status-titles-v1', 'future-format-v2'])
    const busy = await manager.scan('legacy-session-events-v1')
    expect(busy.entries[0]?.state).toBe('busy')
    expect((await manager.execute(busy.token)).entries).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(raw)
    loaded = false
    const stale = await manager.scan('legacy-session-events-v1')
    writeFileSync(path, raw.replace('1004', '1005'))
    expect((await manager.execute(stale.token)).entries[0]).toMatchObject({ state: 'error', detail: expect.stringContaining('changed after scanning') })
    const plan = await manager.scan('legacy-session-events-v1')
    const result = await manager.execute(plan.token)
    expect(result.entries[0]?.state).toBe('migrated')
    expect(readFileSync(result.entries[0]!.backup!, 'utf8')).toContain('1005')
    await expect(manager.execute(plan.token)).rejects.toThrow('expired')
    expect((await manager.scan('legacy-session-events-v1')).entries).toEqual([])
    expect((await manager.scan('future-format-v2')).entries).toEqual([])
    await expect(manager.scan('unknown')).rejects.toThrow('Unknown')
  } finally { dir.remove() }
})

it('scans a 0.2.0 snapshot listing, skipping what the backend already reads', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { MigrationManager } = await import('../src/migrations.ts')
  const dir = scratch('filesnap-migration-shapes')
  const path = join(dir.path, 'session.jsonl')
  const ctx = new Context()
  ctx.provide('sessions', { get: () => undefined })
  let options: unknown = 'unset'
  const located: string[] = []
  ctx.provide('sessionPersistence', {
    open: async () => { throw new Error('nothing opens a listing') },
    async list(received: unknown) {
      options = received
      return [
        { header: { id: 'legacy' }, formatStatus: 'migration-required', revision: 'r1', sizeBytes: 1 },
        { header: { id: 'current' }, formatStatus: 'current', revision: 'r1', sizeBytes: 1 },
      ]
    },
    locate(meta: { id: string }) { located.push(meta.id); return { kind: 'jsonl', path } },
  } as unknown as CordisContext['sessionPersistence'])
  const manager = new MigrationManager(ctx)
  try {
    writeFileSync(path, raw)
    const plan = await manager.scan('legacy-session-events-v1')
    // The options object identifies the 0.2.0 listing call; the artifact the
    // backend already reads in full is skipped without even being located.
    expect(options).toEqual({})
    expect(plan.scanned).toBe(2)
    expect(plan.entries).toEqual([{ session: 'legacy', state: 'ready', events: 2 }])
    expect(located).toEqual(['legacy'])
  } finally { dir.remove() }
})

it('reports a session the backend cannot locate as unsupported rather than failing the scan', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { MigrationManager } = await import('../src/migrations.ts')
  const ctx = new Context()
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sessionPersistence', {
    list: async () => [{ header: { id: 'legacy' }, formatStatus: 'migration-required' }],
  } as unknown as CordisContext['sessionPersistence'])
  const plan = await new MigrationManager(ctx).scan('legacy-session-events-v1')
  expect(plan.scanned).toBe(1)
  expect(plan.entries).toEqual([{ session: 'legacy', state: 'unsupported', events: 0, detail: 'This task supports the JSONL session backend only.' }])
})

it.each([false, true])('migrates legacy titles with a native title revision, preserving every historical event (zstd=%s)', compressed => {
  const old = { seq: 4, time: 1005, type: 'session/title', data: { title: '↩ task', source: { kind: 'user' }, messageSeqs: [] } }
  const text = raw + JSON.stringify(old) + '\n'
  const input = compressed ? zstdCompressSync(Buffer.from(text)) : Buffer.from(text)
  const result = migrateStatusTitles(input, compressed)
  const decoded = decodeArtifact(result.bytes, compressed)
  expect(decoded.startsWith(text)).toBe(true)
  expect(JSON.parse(decoded.trim().split('\n').at(-1)!)).toMatchObject({ type: 'session/title', seq: 5, data: { title: '🔴 Inactive · task', source: { kind: 'user' } } })
  expect(migrateStatusTitles(result.bytes, compressed).events).toBe(0)
  expect(migrateStatusTitles(Buffer.from(text.replace('↩ task', 'ordinary task')), false).events).toBe(0)
})

it('runs both startup migrations automatically, backs up originals, skips live sessions and is idempotent', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { MigrationManager } = await import('../src/migrations.ts')
  const dir = scratch('filesnap-auto-migration')
  const path = join(dir.path, 'session.jsonl')
  const input = raw + JSON.stringify({ seq: 4, time: 1005, type: 'session/title', data: { title: '↩ old title' } }) + '\n'
  writeFileSync(path, input)
  const ctx = new Context()
  let live = true
  ctx.provide('sessions', { get: () => live ? {} : undefined })
  ctx.provide('sessionPersistence', { list: async () => [{ id: 'legacy' }], locate: () => ({ kind: 'jsonl', path }) })
  const manager = new MigrationManager(ctx)
  try {
    await manager.runAutomatic()
    expect(readFileSync(path, 'utf8')).toBe(input)
    expect(manager.automaticStatus().reports.flatMap(report => report.entries).every(row => row.state === 'skipped')).toBe(true)
    live = false
    await manager.runAutomatic()
    const entries = manager.automaticStatus().reports.flatMap(report => report.entries)
    expect(entries.map(row => row.state)).toEqual(['migrated', 'migrated'])
    expect(readFileSync(entries[0]!.backup!, 'utf8')).toBe(input)
    expect(readFileSync(path, 'utf8')).toContain('🔴 Inactive · old title')
    expect(repairArtifact(readFileSync(path), false).events).toBe(0)
    const finished = readFileSync(path)
    await manager.runAutomatic()
    expect(manager.automaticStatus().reports.flatMap(report => report.entries)).toEqual([])
    expect(readFileSync(path)).toEqual(finished)
  } finally { dir.remove() }
})

it('starts migrations from the plugin lifecycle and respects the opt-out', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { registerMigrations } = await import('../src/migrations.ts')
  for (const automatic of [true, false]) {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionPersistence', { list: async () => [], locate: () => undefined })
    const fiber = await ctx.plugin({ apply: (scope: import('@deepseek-ai/cordis').Context) => { registerMigrations(scope, automatic) } })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(ctx.get('filesnapMigrations')?.automaticStatus().started).toBe(automatic)
      expect(ctx.get('filesnapMigrations')?.automaticStatus().running).toBe(false)
    } finally { await fiber.dispose() }
  }
})
