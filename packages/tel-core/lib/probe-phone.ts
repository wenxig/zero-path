import { AdbClient } from './phone/adb-client.ts'
import { PhoneCapabilityProbe } from './phone/capability-probe.ts'

const serial = process.argv.find(argument => argument.startsWith('--serial='))?.slice(9)
const report = new PhoneCapabilityProbe(new AdbClient(undefined, serial)).probe()

console.log(JSON.stringify(report, null, 2))