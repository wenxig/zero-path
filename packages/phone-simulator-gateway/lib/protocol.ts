export type SimulationMode = 'protocol'

export type AudioTransferState = 'IDLE' | 'UPLOADING' | 'DOWNLOADING' | 'DUPLEX'

export type DeviceCommand =
  | { name: 'get_state' }
  | { name: 'start_audio_upload'; fixture: 'silence' | 'tone-440'; durationMs: number }
  | { name: 'stop_audio_upload' }
  | { name: 'start_audio_download'; durationMs: number }
  | { name: 'stop_audio_download' }
  | { name: 'set_simulation_mode'; mode: SimulationMode }
  | { name: 'arm_shell'; pin: string }
  | { name: 'execute_shell'; command: string; sessionToken: string; timeoutMs: number }

export type DeviceEvent = {
  kind: 'event'
  event: 'state' | 'audio_stats' | 'log'
  state?: AudioTransferState
  mode?: SimulationMode
  sentFrames?: number
  receivedFrames?: number
  droppedFrames?: number
  message?: string
}

export type DeviceResult = {
  kind: 'result'
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

export type DeviceHello = {
  kind: 'hello'
  deviceId: string
  deviceName: string
  protocolVersion: 1
}

export type DeviceInboundMessage = DeviceHello | DeviceResult | DeviceEvent

export type GatewayOutboundMessage =
  | { kind: 'hello_ack'; deviceId: string }
  | { kind: 'command'; requestId: string; command: DeviceCommand }

export function isDeviceInboundMessage(value: unknown): value is DeviceInboundMessage {
  if (!isRecord(value)) return false
  if (value.kind === 'hello') {
    return (
      isBoundedString(value.deviceId, 1, 128) &&
      isBoundedString(value.deviceName, 1, 128) &&
      value.protocolVersion === 1
    )
  }
  if (value.kind === 'result') {
    if (!isBoundedString(value.requestId, 1, 64) || typeof value.ok !== 'boolean') return false
    return value.ok ? Object.hasOwn(value, 'data') : isBoundedString(value.error, 1, 2_000)
  }
  if (value.kind !== 'event') return false
  if (value.event === 'log') return isOptionalBoundedString(value.message, 2_000)
  if (value.event !== 'state' && value.event !== 'audio_stats') return false
  if (value.state !== undefined && !isAudioState(value.state)) return false
  if (value.mode !== undefined && value.mode !== 'protocol') return false
  if (!isOptionalCounter(value.sentFrames)) return false
  if (!isOptionalCounter(value.receivedFrames)) return false
  if (!isOptionalCounter(value.droppedFrames)) return false
  if (!isOptionalBoundedString(value.message, 2_000)) return false
  return value.event !== 'state' || (isAudioState(value.state) && value.mode === 'protocol')
}

export function isDeviceCommand(value: unknown): value is DeviceCommand {
  if (!isRecord(value) || typeof value.name !== 'string') return false
  switch (value.name) {
    case 'get_state':
    case 'stop_audio_upload':
    case 'stop_audio_download':
      return true
    case 'start_audio_upload':
      return (
        (value.fixture === 'silence' || value.fixture === 'tone-440') &&
        isDuration(value.durationMs, 3_600_000)
      )
    case 'start_audio_download':
      return isDuration(value.durationMs, 3_600_000)
    case 'set_simulation_mode':
      return value.mode === 'protocol'
    case 'arm_shell':
      return isBoundedString(value.pin, 8, 64)
    case 'execute_shell':
      return (
        isBoundedString(value.command, 1, 20_000) &&
        isBoundedString(value.sessionToken, 1, 128) &&
        isDuration(value.timeoutMs, 120_000)
      )
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isOptionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || isBoundedString(value, 0, max)
}

function isDuration(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= max
}

function isOptionalCounter(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)
}

function isAudioState(value: unknown): value is AudioTransferState {
  return value === 'IDLE' || value === 'UPLOADING' || value === 'DOWNLOADING' || value === 'DUPLEX'
}