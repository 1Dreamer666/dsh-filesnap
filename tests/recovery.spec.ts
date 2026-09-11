import { readFile, writeFile, readdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RecoveryManager } from '../src/recovery.ts'
import { createFilesnapCli, type FilesnapCli, type FilesnapRun } from '../src/cli.ts'
import { BINARY, nodeSubprocess, scratch } from './support.ts'

const aborted: FilesnapRun = { exit: 'aborted', code: null, events: [], refused: 0, stderr: 'interrupted' }

describe.skipIf(!BINARY)('durable interrupted restores with the released engine', () => {
  let workspace: ReturnType<typeof scratch>, data: ReturnType<typeof scratch>, ctx: Context
  let cli: FilesnapCli, manager: RecoveryManager, cwd: string
  const file = (name: string) => join(cwd, name)
  const request = { kind: 'rewind' as const, source: 'parent', destination: 'child', target: 'original' }
  beforeEach(async () => {
    workspace = scratch('recovery-workspace'); data = scratch('recovery-data'); cwd = await realpath(workspace.path)
    ctx = new Context(); ctx.provide('subprocess', nodeSubprocess())
    cli = createFilesnapCli(ctx, { executable: BINARY!, dataDir: data.path, timeoutMs: 30_000, graceMs: 100, maxOutputBytes: 1 << 20 })
    manager = new RecoveryManager(data.path)
    await writeFile(file('a'), 'original a'); await writeFile(file('b'), 'original b')
    expect((await cli.run(['capture', '--session', 'parent', '--turn', 'original'], cwd)).exit).toBe('ok')
    await writeFile(file('a'), 'later a'); await writeFile(file('b'), 'later b')
  })
  afterEach(() => { workspace.remove(); data.remove() })
  async function interrupt(apply: (args: readonly string[], input?: string) => Promise<void> = async () => {}) {
    const broken: FilesnapCli = { run: async (args, dir, signal, input) => {
      if (args[0] !== 'restore') return cli.run(args, dir, signal, input)
      // Failure injection is at the subprocess boundary, after the durable rescue and journal.
      expect((await new RecoveryManager(data.path).list()).length).toBe(1)
      await apply(args, input)
      return aborted
    } }
    await manager.exclusive(cwd, canonical => manager.begin(broken, canonical, request))
    manager = new RecoveryManager(data.path) // All runtime tokens and state are lost on restart.
    return (await manager.list())[0]!
  }
  it.each(['before', 'after'])('recovers across an actual host process exit %s applying files', async phase => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'support/recovery-crash.mjs'), BINARY!, data.path, cwd, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', bytes => { error += String(bytes) })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    expect(code, error).toBe(86)
    const restarted = new RecoveryManager(data.path), item = (await restarted.list())[0]!
    expect(item).toBeDefined()
    const preview = await restarted.preview(cli, item.id, 'apply')
    await restarted.recover(cli, preview.token, () => {})
    expect(await readFile(file('a'), 'utf8')).toBe('original a')
    expect(await restarted.list()).toEqual([])
    expect(await restarted.redoTarget(cwd, 'child')).toBeTruthy()
  })
  it('publishes recovery before writes, blocks new work and resumes after a restart', async () => {
    const item = await interrupt()
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
    await expect(manager.assertReady(cwd)).rejects.toThrow('unfinished')
    const preview = await manager.preview(cli, item.id, 'apply')
    expect(preview.conflicts).toEqual([]); expect(preview.changes).toHaveLength(2)
    await manager.recover(cli, preview.token, () => {})
    expect(await readFile(file('a'), 'utf8')).toBe('original a')
    expect(await manager.list()).toEqual([])
    expect(await manager.redoTarget(cwd, 'child')).toMatchObject({ parent: 'parent' })
    await expect(manager.recover(cli, preview.token, () => {})).rejects.toThrow('expired')
  })
  it('can roll back a partially applied operation without touching unrelated files', async () => {
    const item = await interrupt(async () => { await writeFile(file('a'), 'original a') })
    await writeFile(file('unrelated'), 'keep me')
    const preview = await manager.preview(cli, item.id, 'rollback')
    expect(preview.conflicts).toEqual([])
    await manager.recover(cli, preview.token, () => {})
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
    expect(await readFile(file('b'), 'utf8')).toBe('later b')
    expect(await readFile(file('unrelated'), 'utf8')).toBe('keep me')
    expect(await manager.redoTarget(cwd, 'child')).toBeUndefined()
  })
  it('finalizes an applied restore whose result was lost exactly once', async () => {
    const item = await interrupt(async (args, input) => { expect((await cli.run(args, cwd, undefined, input)).exit).toBe('ok') })
    const preview = await manager.preview(cli, item.id, 'apply')
    expect(preview.changes).toEqual([])
    await manager.recover(cli, preview.token, () => {})
    const recipe = await manager.redoTarget(cwd, 'child')
    expect(recipe).toBeTruthy()
    await manager.exclusive(cwd, canonical => manager.begin(cli, canonical, { kind: 'redo', source: 'child', destination: 'parent', target: recipe!.turn }))
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
    expect(await new RecoveryManager(data.path).redoTarget(cwd, 'child')).toBeNull()
    await expect(manager.preview(cli, item.id, 'apply')).rejects.toThrow('resolved')
  })
  it('refuses edits made after interruption, including files outside the original difference list', async () => {
    await writeFile(file('untouched'), 'untouched')
    const item = await interrupt(async () => { await writeFile(file('a'), 'original a') })
    await writeFile(file('a'), 'user edit'); await writeFile(file('untouched'), 'new user edit')
    const preview = await manager.preview(cli, item.id, 'rollback')
    expect(preview.conflicts).toContain(file('a')); expect(preview.conflicts).toContain(file('untouched'))
    await expect(manager.recover(cli, preview.token, () => {})).rejects.toThrow('Files changed')
    expect(await readFile(file('a'), 'utf8')).toBe('user edit')
    expect(await manager.list()).toHaveLength(1)
  })
  it('checks again after confirmation and rejects stale tokens and changed bytes', async () => {
    const item = await interrupt(), preview = await manager.preview(cli, item.id, 'apply')
    await writeFile(file('a'), 'edited after preview')
    await expect(manager.recover(cli, preview.token, () => {})).rejects.toThrow('Files changed')
    expect(await readFile(file('a'), 'utf8')).toBe('edited after preview')
    expect(await readFile(file('b'), 'utf8')).toBe('later b')
  })
  it('persists rollback direction and can retry a rollback that was itself interrupted', async () => {
    const item = await interrupt(async () => { await writeFile(file('a'), 'original a'); await writeFile(file('b'), 'original b') })
    const preview = await manager.preview(cli, item.id, 'rollback')
    const broken: FilesnapCli = { run: async (args, dir, signal, input) => {
      if (args[0] !== 'restore') return cli.run(args, dir, signal, input)
      await writeFile(file('a'), 'later a')
      return aborted
    } }
    await expect(manager.recover(broken, preview.token, () => {})).rejects.toThrow('interrupted')
    manager = new RecoveryManager(data.path)
    await expect(manager.preview(cli, item.id, 'apply')).rejects.toThrow('Rollback already started')
    const again = await manager.preview(cli, item.id, 'rollback')
    await manager.recover(cli, again.token, () => {})
    expect(await readFile(file('b'), 'utf8')).toBe('later b')
  })
  it('does not lose redo if undoing the rewind is interrupted and rolled back', async () => {
    await manager.exclusive(cwd, canonical => manager.begin(cli, canonical, request))
    const recipe = (await manager.redoTarget(cwd, 'child'))!
    const broken: FilesnapCli = { run: async (args, dir, signal, input) => {
      if (args[0] !== 'restore') return cli.run(args, dir, signal, input)
      await cli.run(args, dir, signal, input)
      return aborted
    } }
    await manager.exclusive(cwd, canonical => manager.begin(broken, canonical, { kind: 'redo', source: 'child', destination: 'parent', target: recipe.turn }))
    manager = new RecoveryManager(data.path)
    const item = (await manager.list())[0]!, preview = await manager.preview(cli, item.id, 'rollback')
    await manager.recover(cli, preview.token, () => {})
    expect(await readFile(file('a'), 'utf8')).toBe('original a')
    expect(await manager.redoTarget(cwd, 'child')).toEqual(recipe)
    await manager.exclusive(cwd, canonical => manager.begin(cli, canonical, { kind: 'redo', source: 'child', destination: 'parent', target: recipe.turn }))
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
  })
  it('keeps target and rescue reachable through engine garbage collection', async () => {
    const item = await interrupt()
    expect((await cli.run(['gc'], cwd)).exit).toBe('ok')
    const preview = await manager.preview(cli, item.id, 'rollback')
    await manager.recover(cli, preview.token, () => {})
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
  })
  it('fails closed for corrupted or future-version records', async () => {
    await interrupt()
    const path = join(manager.root, (await readdir(manager.root)).find(name => name.endsWith('.json'))!)
    const doc = JSON.parse(await readFile(path, 'utf8')); doc.version = 999
    await writeFile(path, JSON.stringify(doc))
    await expect(manager.list()).rejects.toThrow()
    await expect(manager.assertReady(cwd)).rejects.toThrow()
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
  })
  it('restores deleted files and removes recreated files when recovering in either direction', async () => {
    const born = file('born')
    expect((await cli.run(['declare', '--session', 'parent', '--turn', 'original', '--path', born], cwd)).exit).toBe('ok')
    await writeFile(born, 'new file')
    const item = await interrupt(async (args, input) => { await cli.run(args, cwd, undefined, input) })
    await expect(readFile(born)).rejects.toHaveProperty('code', 'ENOENT')
    const preview = await manager.preview(cli, item.id, 'rollback')
    expect(preview.conflicts).toEqual([])
    await manager.recover(cli, preview.token, () => {})
    expect(await readFile(born, 'utf8')).toBe('new file')
  })
  it('refuses recovery under changed ignore rules instead of hiding affected files', async () => {
    const item = await interrupt()
    await writeFile(file('.filesnapignore'), 'a\n')
    await expect(manager.preview(cli, item.id, 'apply')).rejects.toThrow('ignore rules changed')
    expect(await readFile(file('a'), 'utf8')).toBe('later a')
  })
  it('serializes workspace aliases and refuses symlink substitution', async () => {
    const item = await interrupt()
    await expect(manager.exclusive(cwd, () => manager.exclusive(cwd, async () => {}))).rejects.toThrow('already working')
    if (process.platform === 'win32') return
    const { unlink } = await import('node:fs/promises')
    await unlink(file('a')); await symlink(file('b'), file('a'))
    await expect(manager.preview(cli, item.id, 'apply')).rejects.toThrow()
    expect(await readFile(file('b'), 'utf8')).toBe('later b')
  })
})
