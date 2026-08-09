import { randomUUID, timingSafeEqual } from 'node:crypto'

import type { WebSocket } from 'ws'

import {
  isDeviceCommand,
  type AudioTransferState,
  type DeviceCommand,
  type DeviceEvent,
  type DeviceHello,
  type DeviceInboundMessage,
  type DeviceResult,
  type GatewayOutboundMessage,
  type SimulationMode,
} from './protocol.ts'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type RegisteredDevice = {
  deviceId: string
  deviceName: string
  state: AudioTransferState
  mode: SimulationMode
  connectedAt: string
  lastSeenAt: string
  lastEvent?: DeviceEvent
}

export type ShellAuthorization = { connectionId: string; sessionToken: string; expiresAt: string }

type DeviceConnection = RegisteredDevice & {
  connectionId: string
  socket: WebSocket
  pending: Map<string, PendingRequest>
}

type PinFailure = { attempts: number; retryAt: number }

export type DeviceRegistryOptions = {
  token: string
  deviceId: string
  commandTimeoutMs?: number
  now?: () => Date
}

export class DeviceRegistry {
  readonly #token: string
  readonly #deviceId: string
  readonly #commandTimeoutMs: number
  readonly #now: () => Date
  readonly #devices = new Map<string, DeviceConnection>()
  readonly #pinFailures = new Map<string, PinFailure>()

  constructor(options: DeviceRegistryOptions) {
    if (!options.token) throw new Error('SIMULATOR_TOKEN is required')
    if (!options.deviceId) throw new Error('SIMULATOR_DEVICE_ID is required')
    this.#token = options.token
    this.#deviceId = options.deviceId
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 10_000
    this.#now = options.now ?? (() => new Date())
  }

  authenticateCredentials(token: string, deviceId: string): boolean {
    return deviceId === this.#deviceId && safeTokenEquals(token, this.#token)
  }

  authenticateHello(
    message: DeviceInboundMessage,
    authorizedDeviceId: string,
  ): message is DeviceHello {
    return message.kind === 'hello' && message.deviceId === authorizedDeviceId
  }

  register(socket: WebSocket, message: DeviceHello): RegisteredDevice {
    const now = this.#now().toISOString()
    const previous = this.#devices.get(message.deviceId)
    if (previous) {
      previous.socket.terminate()
      this.#rejectPending(previous, new Error('device connection replaced'))
    }

    const device: DeviceConnection = {
      connectionId: randomUUID(),
      deviceId: message.deviceId,
      deviceName: message.deviceName,
      state: 'IDLE',
      mode: 'protocol',
      connectedAt: now,
      lastSeenAt: now,
      socket,
      pending: new Map(),
    }
    this.#devices.set(message.deviceId, device)
    return this.#publicDevice(device)
  }

  unregister(deviceId: string, socket: WebSocket): void {
    const device = this.#devices.get(deviceId)
    if (!device || device.socket !== socket) return
    this.#rejectPending(device, new Error('device disconnected'))
    this.#devices.delete(deviceId)
  }

  handleMessage(deviceId: string, socket: WebSocket, message: DeviceInboundMessage): boolean {
    const device = this.#devices.get(deviceId)
    if (!device || device.socket !== socket || message.kind === 'hello') return false
    device.lastSeenAt = this.#now().toISOString()
    if (message.kind === 'result') return this.#handleResult(device, message)
    device.lastEvent = message
    if (message.event === 'state') {
      device.state = message.state as AudioTransferState
      device.mode = message.mode as SimulationMode
    }
    return true
  }

  list(): RegisteredDevice[] {
    return [...this.#devices.values()].map(device => this.#publicDevice(device))
  }

  async invoke(
    deviceId: string,
    command: DeviceCommand,
    timeoutMs = this.#commandTimeoutMs,
  ): Promise<unknown> {
    if (!isDeviceCommand(command)) throw new Error('unsupported device command')
    const device = this.#devices.get(deviceId)
    if (!device) throw new Error(`device is not connected: ${deviceId}`)
    if (device.socket.readyState !== device.socket.OPEN) {
      throw new Error(`device is not ready: ${deviceId}`)
    }
    if (device.pending.size >= MAX_PENDING_COMMANDS) {
      throw new Error(`too many pending commands for device: ${deviceId}`)
    }

    const requestId = randomUUID()
    const message: GatewayOutboundMessage = { kind: 'command', requestId, command }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        device.pending.delete(requestId)
        reject(new Error(`device command timed out: ${command.name}`))
      }, timeoutMs)
      device.pending.set(requestId, { resolve, reject, timer })
      device.socket.send(JSON.stringify(message), error => {
        if (!error) return
        const pending = device.pending.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        device.pending.delete(requestId)
        pending.reject(new Error(`failed to send device command: ${error.message}`))
      })
    })
  }

  async armShell(deviceId: string, pin: string): Promise<ShellAuthorization> {
    const now = this.#now().getTime()
    const failure = this.#pinFailures.get(deviceId)
    if (failure && now < failure.retryAt) {
      throw new Error(
        `PIN verification is rate limited for ${Math.ceil((failure.retryAt - now) / 1_000)} seconds`,
      )
    }
    try {
      const result = await this.invoke(deviceId, { name: 'arm_shell', pin })
      if (!isShellSession(result)) throw new Error('device returned an invalid shell session')
      const device = this.#devices.get(deviceId)
      if (!device) throw new Error(`device is not connected: ${deviceId}`)
      const expiresAt = Date.parse(result.expiresAt)
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        expiresAt > now + MAX_SHELL_SESSION_MS
      ) {
        throw new Error('device returned an invalid shell session expiry')
      }
      this.#pinFailures.delete(deviceId)
      return { connectionId: device.connectionId, ...result }
    } catch (error) {
      if (error instanceof Error && /invalid PIN|locked|rate limit/i.test(error.message)) {
        this.#recordPinFailure(deviceId, now)
      }
      throw error
    }
  }

  async executeShell(
    deviceId: string,
    command: string,
    authorization: ShellAuthorization | undefined,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const device = this.#devices.get(deviceId)
    if (!device || !authorization || device.connectionId !== authorization.connectionId) {
      throw new Error('shell is not armed for this MCP session; verify the PIN first')
    }
    if (Date.parse(authorization.expiresAt) <= this.#now().getTime()) {
      throw new Error('shell authorization expired; verify the PIN again')
    }
    return this.invoke(
      deviceId,
      { name: 'execute_shell', command, sessionToken: authorization.sessionToken, timeoutMs },
      timeoutMs + 5_000,
    )
  }

  #handleResult(device: DeviceConnection, message: DeviceResult): boolean {
    const pending = device.pending.get(message.requestId)
    if (!pending) return false
    clearTimeout(pending.timer)
    device.pending.delete(message.requestId)
    if (message.ok) pending.resolve(message.data)
    else pending.reject(new Error(message.error ?? 'device command failed'))
    return true
  }

  #rejectPending(device: DeviceConnection, error: Error): void {
    for (const [requestId, pending] of device.pending) {
      clearTimeout(pending.timer)
      device.pending.delete(requestId)
      pending.reject(error)
    }
  }

  #recordPinFailure(deviceId: string, now: number): void {
    const attempts = Math.min((this.#pinFailures.get(deviceId)?.attempts ?? 0) + 1, 31)
    const delayMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 10), MAX_PIN_DELAY_MS)
    this.#pinFailures.set(deviceId, { attempts, retryAt: now + delayMs })
  }

  #publicDevice(device: DeviceConnection): RegisteredDevice {
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      state: device.state,
      mode: device.mode,
      connectedAt: device.connectedAt,
      lastSeenAt: device.lastSeenAt,
      lastEvent: device.lastEvent,
    }
  }
}

function isShellSession(value: unknown): value is { sessionToken: string; expiresAt: string } {
  if (!value || typeof value !== 'object') return false
  const session = value as Record<string, unknown>
  return (
    typeof session.sessionToken === 'string' &&
    session.sessionToken.length > 0 &&
    session.sessionToken.length <= 128 &&
    typeof session.expiresAt === 'string'
  )
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

const MAX_PENDING_COMMANDS = 16
const MAX_SHELL_SESSION_MS = 16 * 60 * 1_000
const MAX_PIN_DELAY_MS = 15 * 60 * 1_000