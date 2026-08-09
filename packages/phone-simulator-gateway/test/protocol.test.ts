import { describe, expect, it } from 'vitest'

import { isDeviceCommand, isDeviceInboundMessage } from '../lib/protocol.ts'

describe('device protocol validation', () => {
  it('accepts the bounded protocol messages used by Android', () => {
    expect(
      isDeviceInboundMessage({
        kind: 'event',
        event: 'state',
        state: 'UPLOADING',
        mode: 'protocol',
        sentFrames: 4,
        receivedFrames: 2,
        droppedFrames: 0,
        message: 'uploading',
      }),
    ).toBe(true)
    expect(isDeviceCommand({ name: 'arm_shell', pin: '12345678' })).toBe(true)
  })

  it('rejects unsupported modes, short PINs, and malformed results', () => {
    expect(isDeviceCommand({ name: 'set_simulation_mode', mode: 'hfp' })).toBe(false)
    expect(isDeviceCommand({ name: 'arm_shell', pin: '1234' })).toBe(false)
    expect(isDeviceInboundMessage({ kind: 'result', requestId: 'id', ok: true })).toBe(false)
    expect(
      isDeviceInboundMessage({ kind: 'event', event: 'state', state: 'ROOTED', mode: 'protocol' }),
    ).toBe(false)
  })
})