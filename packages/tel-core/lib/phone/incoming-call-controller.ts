import type { AdbClient } from './adb-client.ts'

export type CallState = 'ACTIVE' | 'DISCONNECTED' | 'RINGING' | 'UNKNOWN'

const ANDROID_10_ACCEPT_RINGING_CALL_TRANSACTION = '31'

export class IncomingCallController {
  readonly #adb: AdbClient

  constructor(adb: AdbClient) {
    this.#adb = adb
  }

  getState(): CallState {
    const telecom = this.#adb.runShell('dumpsys telecom | head -n 18')
    const match = telecom.match(/\[TC@\d+, ([A-Z_]+),/)
    const state = match?.[1]

    return state === 'ACTIVE' || state === 'DISCONNECTED' || state === 'RINGING' ? state : 'UNKNOWN'
  }

  answer(): void {
    this.#adb.runServiceCall('telecom', ANDROID_10_ACCEPT_RINGING_CALL_TRANSACTION, [
      's16',
      'com.android.shell',
    ])
  }

  async waitAndAnswer(timeoutMs = 120_000, pollIntervalMs = 500): Promise<CallState> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.getState() === 'RINGING') {
        this.answer()
        await this.#delay(1_000)
        return this.getState()
      }

      await this.#delay(pollIntervalMs)
    }

    return 'UNKNOWN'
  }

  #delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
  }
}