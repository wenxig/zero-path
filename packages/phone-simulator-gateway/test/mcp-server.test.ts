import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeviceRegistry } from '../lib/device-registry.ts'
import { createMcpServer } from '../lib/mcp-server.ts'
import type { DeviceHello, DeviceResult } from '../lib/protocol.ts'

function socket() {
  return { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() } as never
}

const hello: DeviceHello = {
  kind: 'hello',
  deviceId: 'test-phone',
  deviceName: 'Test Phone',
  protocolVersion: 1,
}

describe('MCP shell authorization', () => {
  const resources: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(resources.splice(0).map(resource => resource.close()))
  })

  it('does not share an armed shell capability with another MCP server session', async () => {
    const now = new Date('2026-08-09T12:00:00.000Z')
    const registry = new DeviceRegistry({ token: 'secret', deviceId: 'test-phone', now: () => now })
    const deviceSocket = socket()
    registry.register(deviceSocket, hello)
    const clientA = await connectedClient(registry)
    const clientB = await connectedClient(registry)
    resources.push(clientA, clientB)

    const arming = clientA.callTool({
      name: 'arm_shell',
      arguments: { deviceId: 'test-phone', pin: '12345678' },
    })
    await vi.waitFor(() => expect(deviceSocket.send).toHaveBeenCalledTimes(1))
    resolveLastCommand(registry, deviceSocket, {
      ok: true,
      data: { sessionToken: 'shell-token', expiresAt: '2026-08-09T12:15:00.000Z' },
    })
    expect((await arming).isError).not.toBe(true)

    await expect(
      clientB.callTool({
        name: 'execute_shell',
        arguments: { deviceId: 'test-phone', command: 'id', timeoutMs: 1_000 },
      }),
    ).resolves.toMatchObject({ isError: true })
    expect(deviceSocket.send).toHaveBeenCalledTimes(1)

    const execution = clientA.callTool({
      name: 'execute_shell',
      arguments: { deviceId: 'test-phone', command: 'id', timeoutMs: 1_000 },
    })
    await vi.waitFor(() => expect(deviceSocket.send).toHaveBeenCalledTimes(2))
    resolveLastCommand(registry, deviceSocket, {
      ok: true,
      data: { exitCode: 0, output: 'uid=1000', truncated: false, durationMs: 1 },
    })
    expect((await execution).isError).not.toBe(true)
  })
})

async function connectedClient(registry: DeviceRegistry): Promise<Client> {
  const server = createMcpServer(registry)
  const client = new Client({ name: 'gateway-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const originalClose = client.close.bind(client)
  client.close = async () => {
    await originalClose()
    await server.close()
  }
  return client
}

function resolveLastCommand(
  registry: DeviceRegistry,
  deviceSocket: ReturnType<typeof socket>,
  result: Omit<DeviceResult, 'kind' | 'requestId'>,
): void {
  const command = JSON.parse(deviceSocket.send.mock.calls.at(-1)?.[0] as string) as {
    requestId: string
  }
  registry.handleMessage('test-phone', deviceSocket, {
    kind: 'result',
    requestId: command.requestId,
    ...result,
  })
}