// Real host-process termination, after publishing recovery state and optionally
// after the real engine has applied files, before the host can commit completion.
import { spawn } from 'node:child_process'
import { RecoveryManager } from '../../src/recovery.ts'
import { parseEvents } from '../../src/cli.ts'
const [binary, data, cwd, phase] = process.argv.slice(2)
const cli = { async run(args, dir, _signal, input) {
  if (args[0] === 'restore' && phase === 'before') process.exit(86)
  const child = spawn(binary, ['--data-dir', data, ...args], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end(input)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  if (args[0] === 'restore' && phase === 'after') process.exit(86)
  return { code, exit: code === 0 ? 'ok' : code === 1 ? 'partial' : 'failed', ...parseEvents(stdout), stderr }
} }
const manager = new RecoveryManager(data)
await manager.exclusive(cwd, canonical => manager.begin(cli, canonical, { kind: 'rewind', source: 'parent', destination: 'child', target: 'original' }))
throw new Error('Crash injection was not reached')
