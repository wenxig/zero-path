import type { AdbClient } from './adb-client.ts'

export type ProbeConclusion = 'available' | 'blocked' | 'requires-live-call'

export interface PhoneCapabilityReport {
  device: {
    model: string
    androidVersion: string
    sdk: number
    harmonyVersion: string
    connected: boolean
  }
  security: { rootAvailable: boolean; selinux: string }
  capabilities: {
    adbCallStateMonitoring: ProbeConclusion
    adbTelecomAnswer: ProbeConclusion
    callAudioCapture: ProbeConclusion
    callAudioInjection: ProbeConclusion
  }
  evidence: string[]
  recommendation: string
}

export class PhoneCapabilityProbe {
  readonly #adb: AdbClient

  constructor(adb: AdbClient) {
    this.#adb = adb
  }

  probe(): PhoneCapabilityReport {
    const devices = this.#adb.getDeviceList()
    const properties = this.#adb.runShell(
      'printf "%s\\n" "$(getprop ro.product.model)" "$(getprop ro.build.version.release)" "$(getprop ro.build.version.sdk)" "$(getprop hw_sc.build.platform.version)"',
    )
    const [model = '', androidVersion = '', sdkText = '0', harmonyVersion = ''] =
      properties.split('\n')
    const identity = this.#adb.runShell(
      'id; if command -v su >/dev/null; then echo ROOT_PRESENT; fi',
    )
    const selinux = this.#adb.runShell('getenforce')
    const telecom = this.#adb.runShell('dumpsys telecom | head -n 30')
    const audioPolicy = this.#adb.runShell(
      'dumpsys media.audio_policy | grep -E "AUDIO_DEVICE_(OUT_TELEPHONY_TX|IN_TELEPHONY_RX|IN_VOICE_CALL)" | head -n 8',
    )
    const sdk = Number.parseInt(sdkText, 10) || 0
    const rootAvailable = identity.includes('uid=0') || identity.includes('ROOT_PRESENT')
    const hasTelephonyPorts =
      audioPolicy.includes('TELEPHONY') || audioPolicy.includes('VOICE_CALL')

    return {
      device: { model, androidVersion, sdk, harmonyVersion, connected: /\bdevice\b/.test(devices) },
      security: { rootAvailable, selinux },
      capabilities: {
        adbCallStateMonitoring: telecom.includes('CallsManager:') ? 'available' : 'blocked',
        adbTelecomAnswer: sdk === 29 ? 'available' : 'requires-live-call',
        callAudioCapture: rootAvailable ? 'requires-live-call' : 'blocked',
        callAudioInjection: rootAvailable ? 'requires-live-call' : 'blocked',
      },
      evidence: [
        `Android ${androidVersion} / API ${sdk}`,
        `root=${rootAvailable ? 'yes' : 'no'}, SELinux=${selinux}`,
        `telephony audio ports=${hasTelephonyPorts ? 'present' : 'not exposed'}`,
        sdk < 30
          ? 'scrcpy audio forwarding requires Android 11 or newer'
          : 'scrcpy version and device audio-source permissions still require validation',
      ],
      recommendation:
        !rootAvailable || sdk < 30
          ? 'Use ADB for call-state monitoring and answer/hang-up control; use a CTIA analog audio path or USB audio accessory for full-duplex call audio.'
          : 'Run a live incoming-call capture test before selecting the final audio path.',
    }
  }
}