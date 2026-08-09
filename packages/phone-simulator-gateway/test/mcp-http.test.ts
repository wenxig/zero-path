import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { DeviceRegistry } from '../lib/device-registry.ts'
import { createMcpServer, handleMcpRequest, type McpHttpSession } from '../lib/mcp-server.ts'

describe('Streamable HTTP session routing', () => {
  let server: Server | undefined
  const sessions = new Map<string, McpHttpSession>()

  afterEach(async () => {
    await Promise.all([...sessions.values()].map(session => session.server.close()))
    sessions.clear()
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  })

  it('creates only initialize sessions and rejects unknown session IDs', async () => {
    const registry = new DeviceRegistry({ token: 'secret', deviceId: 'test-phone' })
    server = createServer((request, response) => {
      void handleMcpRequest(request, response, sessions, () => createMcpServer(registry))
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}`

    const invalid = await fetch(endpoint, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(invalid.status).toBe(400)
    expect(sessions.size).toBe(0)

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({ payload: 'x'.repeat(1024 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect(sessions.size).toBe(0)

    const initialized = await fetch(endpoint, {
      method: 'POST',
      headers: REQUEST_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'gateway-test', version: '1.0.0' },
        },
      }),
    })
    expect(initialized.status).toBe(200)
    await initialized.text()
    const sessionId = initialized.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()
    expect(sessions.size).toBe(1)

    const unknown = await fetch(endpoint, {
      headers: { ...REQUEST_HEADERS, 'mcp-session-id': 'unknown-session' },
    })
    expect(unknown.status).toBe(404)

    const deleted = await fetch(endpoint, {
      method: 'DELETE',
      headers: { ...REQUEST_HEADERS, 'mcp-session-id': sessionId as string },
    })
    expect(deleted.ok).toBe(true)
    await deleted.text()
    expect(sessions.size).toBe(0)
  })
})

const REQUEST_HEADERS = {
  'accept': 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': '2025-06-18',
}