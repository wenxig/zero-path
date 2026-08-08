import { describe, expect, it } from 'vitest'

import { AdbClient, type CommandExecutor } from '../lib/phone/adb-client.ts'
import { PhoneCapabilityProbe } from '../lib/phone/capability-probe.ts'

class FakeExecutor implements CommandExecutor {
  execute(command: string, args: readonly string[]): string {
    const invocation = `${command} ${args.join(' ')}`

    if (invocation.includes('devices -l'))
      return 'List of devices attached\nphone device model:DVC_AN00'
    if (invocation.includes('ro.product.model')) return 'DVC-AN00\n10\n29\n3.0.0'
    if (invocation.includes('command -v su')) return 'uid=2000(shell) gid=2000(shell)'
    if (invocation.includes('getenforce')) return 'Enforcing'
    if (invocation.includes('dumpsys telecom')) return 'CallsManager:\n  mCalls:'
    if (invocation.includes('media.audio_policy')) return 'AUDIO_DEVICE_OUT_TELEPHONY_TX'

    throw new Error(`Unexpected command: ${invocation}`)
  }
}

describe('PhoneCapabilityProbe', () => {
  it('identifies the software-only duplex audio blockers on the connected phone', () => {
    const report = new PhoneCapabilityProbe(new AdbClient(new FakeExecutor())).probe()

    expect(report.device).toMatchObject({ model: 'DVC-AN00', sdk: 29, connected: true })
    expect(report.security).toEqual({ rootAvailable: false, selinux: 'Enforcing' })
    expect(report.capabilities).toMatchObject({
      adbCallStateMonitoring: 'available',
      adbTelecomAnswer: 'available',
      callAudioCapture: 'blocked',
      callAudioInjection: 'blocked',
    })
    expect(report.recommendation).toContain('CTIA analog audio path')
  })
})