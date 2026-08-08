import { describe, expect, it } from 'vitest'

import { AdbClient, type CommandExecutor } from '../lib/phone/adb-client.ts'
import { IncomingCallController } from '../lib/phone/incoming-call-controller.ts'

class RecordingExecutor implements CommandExecutor {
  readonly invocations: string[] = []

  execute(command: string, args: readonly string[]): string {
    const invocation = `${command} ${args.join(' ')}`
    this.invocations.push(invocation)

    if (invocation.includes('dumpsys telecom')) {
      return 'mCalls:\n[TC@3, RINGING, com.android.phone/TelephonyConnectionService]'
    }

    if (invocation.includes('service call telecom 31')) return 'Result: Parcel(00000000)'

    throw new Error(`Unexpected command: ${invocation}`)
  }
}

describe('IncomingCallController', () => {
  it('uses the verified Android 10 telecom transaction to answer', () => {
    const executor = new RecordingExecutor()
    const controller = new IncomingCallController(new AdbClient(executor))

    expect(controller.getState()).toBe('RINGING')
    controller.answer()

    expect(executor.invocations.at(-1)).toBe(
      'adb shell service call telecom 31 s16 com.android.shell',
    )
  })
})