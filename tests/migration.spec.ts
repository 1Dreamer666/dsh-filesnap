import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decodeArtifact, migrateFile, repairArtifact } from '../src/migrate-session-logs.ts'
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
    expect(manager.catalogue().map(task => task.id)).toEqual(['legacy-session-events-v1', 'future-format-v2'])
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
