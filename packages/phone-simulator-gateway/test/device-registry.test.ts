import { describe, expect, it, vi } from 'vitest'

import { DeviceRegistry } from '../lib/device-registry.ts'
import type { DeviceHello, DeviceResult } from '../lib/protocol.ts'

function socket() {
  return { OPEN: 1, readyState: 1, send: vi.fn(), close: vi.fn(), terminate: vi.fn() } as never
}

const hello = (): DeviceHello => ({
  kind: 'hello',
  deviceId: 'test-phone',
  deviceName: 'Test Phone',
  protocolVersion: 1,
})

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

function registry(options: Partial<ConstructorParameters<typeof DeviceRegistry>[0]> = {}) {
  return new DeviceRegistry({ token: 'secret', deviceId: 'test-phone', ...options })
}

describe('DeviceRegistry', () => {
  it('binds credentials and hello messages to the configured device', () => {
    const devices = registry()
    const deviceSocket = socket()

    expect(devices.authenticateCredentials('secret', 'test-phone')).toBe(true)
    expect(devices.authenticateCredentials('secret', 'other-phone')).toBe(false)
    expect(devices.authenticateCredentials('wrong', 'test-phone')).toBe(false)
    expect(devices.authenticateHello(hello(), 'test-phone')).toBe(true)
    devices.register(deviceSocket, hello())

    expect(devices.list()).toMatchObject([
      { deviceId: 'test-phone', deviceName: 'Test Phone', state: 'IDLE', mode: 'protocol' },
    ])
  })

  it('rejects a command when the device does not answer', async () => {
    const devices = registry({ commandTimeoutMs: 1 })
    const deviceSocket = socket()
    devices.register(deviceSocket, hello())

    await expect(devices.invoke('test-phone', { name: 'get_state' })).rejects.toThrow('timed out')
    expect(deviceSocket.send).toHaveBeenCalledOnce()
  })

  it('accepts results only from the current device socket', async () => {
    const devices = registry()
    const currentSocket = socket()
    const staleSocket = socket()
    devices.register(currentSocket, hello())

    const pending = devices.invoke('test-phone', { name: 'get_state' })
    const command = JSON.parse(currentSocket.send.mock.calls[0][0] as string) as {
      requestId: string
    }
    expect(
      devices.handleMessage('test-phone', staleSocket, {
        kind: 'result',
        requestId: command.requestId,
        ok: true,
        data: { state: 'IDLE' },
      }),
    ).toBe(false)
    resolveLastCommand(devices, currentSocket, { ok: true, data: { state: 'IDLE' } })

    await expect(pending).resolves.toEqual({ state: 'IDLE' })
  })

  it('requires a connection-bound shell authorization', async () => {
    const now = new Date('2026-08-09T12:00:00.000Z')
    const devices = registry({ now: () => now })
    const deviceSocket = socket()
    devices.register(deviceSocket, hello())

    await expect(devices.executeShell('test-phone', 'id', undefined)).rejects.toThrow(
      'verify the PIN',
    )

    const arming = devices.armShell('test-phone', '12345678')
    resolveLastCommand(devices, deviceSocket, {
      ok: true,
      data: { sessionToken: 'shell-token', expiresAt: '2026-08-09T12:15:00.000Z' },
    })
    const authorization = await arming

    const execution = devices.executeShell('test-phone', 'id', authorization)
    const shellMessage = JSON.parse(deviceSocket.send.mock.calls[1][0] as string) as {
      command: { sessionToken: string }
    }
    expect(shellMessage.command.sessionToken).toBe('shell-token')
    resolveLastCommand(devices, deviceSocket, {
      ok: true,
      data: { exitCode: 0, output: 'uid=1000' },
    })
    await expect(execution).resolves.toMatchObject({ exitCode: 0 })

    devices.unregister('test-phone', deviceSocket)
    devices.register(socket(), hello())
    await expect(devices.executeShell('test-phone', 'id', authorization)).rejects.toThrow(
      'verify the PIN',
    )
  })

  it('rate limits failed PIN attempts at the gateway', async () => {
    let now = new Date('2026-08-09T12:00:00.000Z')
    const devices = registry({ now: () => now })
    const deviceSocket = socket()
    devices.register(deviceSocket, hello())

    const arming = devices.armShell('test-phone', 'bad-pin!')
    resolveLastCommand(devices, deviceSocket, { ok: false, error: 'Invalid PIN' })
    await expect(arming).rejects.toThrow('Invalid PIN')
    await expect(devices.armShell('test-phone', '12345678')).rejects.toThrow('rate limited')

    now = new Date(now.getTime() + 1_000)
    const retry = devices.armShell('test-phone', '12345678')
    resolveLastCommand(devices, deviceSocket, {
      ok: true,
      data: { sessionToken: 'shell-token', expiresAt: '2026-08-09T12:15:00.000Z' },
    })
    await expect(retry).resolves.toMatchObject({ sessionToken: 'shell-token' })
  })
})