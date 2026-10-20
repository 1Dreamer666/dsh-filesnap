/**
 * The UI channel mounts even where the harness's own registry cannot.
 *
 * The direct route exists because of a harness regression rather than this
 * plugin's own bug: in the Desktop app's harness build (0.2.0-rc.2) the
 * Connection service lives under a context that cannot see `webServer`, so
 * `rpc.handle` throws while mounting, no route is added, and every browser
 * call would meet the app host's 405.
 * The pinned CI harness does not reproduce that shape — `rpc.handle` still
 * works there — so the shape is stood up here: a `connection` stand-in whose
 * registration throws exactly as the real one does, and a `webServer`
 * stand-in that records what gets mounted. The recorded route then answers
 * real HTTP requests, because the contract worth testing is the bytes the
 * browser half receives, not that a function was called.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UI_CHANNEL, mountUiChannel } from '../src/route.ts'
import type { UiDispatch } from '../src/route.ts'
import { registerRpc } from '../src/rpc.ts'

/** One decoded call the channel dispatched, in order. */
interface Call {
  readonly endpoint: string
  readonly payload: unknown
  readonly signal: AbortSignal
}

/** A route one of the mounting paths registered. */
interface MountedRoute {
  readonly kind: string
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** An error envelope as the browser half reads it. */
interface ErrorEnvelope {
  readonly type: string
  readonly rpcId: string
  readonly result: {
    readonly ok: false
    readonly error: {
      readonly code: string
      readonly message: string
      readonly details: { readonly issues?: readonly unknown[] }
    }
  }
}

/** Loopback servers to close after each test. */
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

/**
 * A context shaped like the affected deployment: `connection` is available to
 * the plugin, `webServer` exists, and `rpc.handle` throws the way the real
 * registration does when its owning context cannot see the web server.
 *
 * @param options - the shape to stand up, and who answers a dispatch.
 * @returns what both mounting paths did, in order.
 */
async function mount(options: {
  officialThrows: boolean
  rejection?: number | undefined
  dispatch?: UiDispatch | undefined
}): Promise<{ routes: MountedRoute[]; calls: Call[]; channels: string[] }> {
  const routes: MountedRoute[] = []
  const calls: Call[] = []
  const channels: string[] = []
  const dispatch: UiDispatch = options.dispatch ?? (async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal })
    return { ok: true, value: { ok: true, message: `answered ${endpoint}` } }
  })
  const ctx = new Context()
  ctx.provide('connection', {
    rpc: {
      handle: (channel: string, _handler: unknown) => {
        channels.push(channel)
        if (options.officialThrows) throw new Error('cannot get property "webServer" without inject')
        return () => Promise.resolve()
      },
    },
    requestRejection: () => options.rejection,
  })
  ctx.provide('webServer', {
    register: (route: MountedRoute) => {
      routes.push(route)
      return () => {}
    },
  })
  await ctx.inject(['connection'], rpcCtx => { mountUiChannel(rpcCtx, dispatch) })
  return { routes, calls, channels }
}

/** Serve one mounted route on a real loopback port. */
async function serve(route: MountedRoute): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => { server.close(() => resolve()) }),
  }
}

/**
 * Mount the affected shape, start its route, and hand back a caller that
 * speaks the browser half's protocol.
 *
 * @param options - the shape to stand up.
 * @returns the mount record plus `call`, which posts one envelope per endpoint.
 */
async function deployed(options: {
  rejection?: number | undefined
  dispatch?: UiDispatch | undefined
} = {}): Promise<{
  origin: string
  calls: Call[]
  call: (endpoint: string, payload: unknown) => Promise<Response>
  envelope: (method: string, payload?: unknown) => object
}> {
  const harness = await mount({ officialThrows: true, rejection: options.rejection, dispatch: options.dispatch })
  const [route] = harness.routes
  if (route === undefined) throw new Error('the direct route was not mounted')
  const { origin, close } = await serve(route)
  closers.push(close)
  return {
    origin,
    calls: harness.calls,
    envelope: (method, payload = {}) => ({ type: 'client-request', rpcId: 'rpc-1', method, payload }),
    call: (endpoint, payload) => fetch(`${origin}${UI_CHANNEL}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  }
}

describe('mounting the UI channel', () => {
  it('leaves the official registration owning the channel when it succeeds', async () => {
    const { routes, channels } = await mount({ officialThrows: false })
    expect(channels).toEqual([UI_CHANNEL])
    expect(routes).toEqual([])
  })

  it('mounts the prefix route from this plugin when the official registration throws', async () => {
    const { routes, channels } = await mount({ officialThrows: true })
    expect(channels).toEqual([UI_CHANNEL])
    expect(routes.map(route => [route.kind, route.path])).toEqual([['prefix', UI_CHANNEL]])
  })

  it('wires the plugin registration through the direct route end to end', async () => {
    // The assertion the fix exists for: with `rpc.handle` throwing, the real
    // `registerRpc` must still leave a working channel behind. Before the fix
    // the throw escaped this registration and no route was ever mounted.
    const routes: MountedRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } },
      requestRejection: () => undefined,
    })
    ctx.provide('filesnap', { recovery: { list: async () => [{ id: 'recovery-1' }] } })
    ctx.provide('webServer', {
      register: (route: MountedRoute) => {
        routes.push(route)
        return () => {}
      },
    })
    registerRpc(ctx)
    await vi.waitFor(() => { expect(routes).toHaveLength(1) })
    const [route] = routes
    if (route === undefined) throw new Error('the direct route was not mounted')
    const { origin, close } = await serve(route)
    closers.push(close)
    const response = await fetch(`${origin}${UI_CHANNEL}/recovery-list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-9', method: 'recovery-list', payload: {} }),
    })
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-9',
      result: { ok: true, value: [{ id: 'recovery-1' }] },
    })
  })
})

describe('serving the direct route', () => {
  it('answers with the complete server-response envelope', async () => {
    const { call, envelope, calls } = await deployed()
    const response = await call('points', envelope('points', { sessionId: 'session-a' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { ok: true, message: 'answered points' } },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.endpoint).toBe('points')
    expect(calls[0]?.payload).toEqual({ sessionId: 'session-a' })
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a business failure inside the value', async () => {
    const { call, envelope } = await deployed({
      dispatch: async () => ({ ok: true, value: { ok: false, error: 'nothing to redo' } }),
    })
    const response = await call('redo', envelope('redo'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { ok: false, error: 'nothing to redo' } },
    })
  })

  it('answers the admission fence before dispatch', async () => {
    const unauthorized = await deployed({ rejection: 401 })
    const forbidden = await deployed({ rejection: 403 })
    const request = unauthorized.envelope('points')
    const first = await unauthorized.call('points', request)
    expect(first.status).toBe(401)
    expect(await first.text()).toBe('unauthorized')
    const second = await forbidden.call('points', request)
    expect(second.status).toBe(403)
    expect(await second.text()).toBe('forbidden')
    expect(unauthorized.calls).toEqual([])
    expect(forbidden.calls).toEqual([])
  })

  it('answers 404 outside the POST endpoint shape', async () => {
    const { call, origin, envelope } = await deployed()
    expect((await fetch(`${origin}${UI_CHANNEL}/points`, { method: 'GET' })).status).toBe(404)
    expect((await fetch(`${origin}${UI_CHANNEL}`, { method: 'POST' })).status).toBe(404)
    expect((await call('', envelope('points'))).status).toBe(404)
  })

  it('answers 415 without a JSON content type', async () => {
    const { origin, envelope } = await deployed()
    const response = await fetch(`${origin}${UI_CHANNEL}/points`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(envelope('points')),
    })
    expect(response.status).toBe(415)
  })

  it('answers 400 when the body is not JSON', async () => {
    const { origin } = await deployed()
    const response = await fetch(`${origin}${UI_CHANNEL}/points`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('body is not JSON')
  })

  it('answers a malformed envelope with the invalid-envelope failure', async () => {
    const { call } = await deployed()
    const named = await call('points', { rpcId: 'rpc-7' })
    const body = await named.json() as ErrorEnvelope
    expect(body.rpcId).toBe('rpc-7')
    expect(body.result.error.code).toBe('gateway/bad-request')
    expect(body.result.error.message).toBe('invalid client-request message')
    expect(body.result.error.details.issues?.length).toBeGreaterThan(0)
    const anonymous = await call('points', { method: 'points' })
    expect((await anonymous.json() as ErrorEnvelope).rpcId).toBe('invalid-request')
  })

  it('answers a method/endpoint mismatch with the gateway failure', async () => {
    const { call } = await deployed()
    const response = await call('points', { type: 'client-request', rpcId: 'rpc-3', method: 'other', payload: {} })
    const body = await response.json() as ErrorEnvelope
    expect(body.rpcId).toBe('rpc-3')
    expect(body.result.error.message).toBe('method "other" does not match endpoint "points"')
  })

  it('answers a handler failure as a bare 500', async () => {
    const { call, envelope } = await deployed({
      dispatch: async () => { throw new Error('engine gone') },
    })
    const response = await call('points', envelope('points'))
    expect(response.status).toBe(500)
    expect(await response.text()).toBe('handler failure: Error: engine gone')
  })

  it('refuses a declared oversize body with 413 before reading it', async () => {
    const { origin } = await deployed()
    const { port } = new URL(origin)
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1')
      let received = ''
      socket.setTimeout(10_000, () => { socket.destroy(new Error('the bridge never answered')) })
      socket.on('connect', () => {
        socket.write([
          `POST ${UI_CHANNEL}/points HTTP/1.1`,
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          `Content-Length: ${300 * 1024 * 1024 + 1}`,
          '',
          '',
        ].join('\r\n'))
      })
      socket.on('data', chunk => { received += String(chunk) })
      socket.on('close', () => { resolve(received.split('\r\n', 1)[0] ?? '') })
      socket.on('error', reject)
    })
    expect(status).toContain('413')
  })
})
