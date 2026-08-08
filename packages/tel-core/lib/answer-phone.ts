import { AdbClient } from './phone/adb-client.ts'
import { IncomingCallController } from './phone/incoming-call-controller.ts'

const serial = process.argv.find(argument => argument.startsWith('--serial='))?.slice(9)
const timeoutArgument = process.argv.find(argument => argument.startsWith('--timeout='))?.slice(10)
const timeoutMs = timeoutArgument ? Number.parseInt(timeoutArgument, 10) * 1_000 : 120_000
const controller = new IncomingCallController(new AdbClient(undefined, serial))
const state = await controller.waitAndAnswer(timeoutMs)

console.log(JSON.stringify({ state }))
process.exitCode = state === 'ACTIVE' ? 0 : 1