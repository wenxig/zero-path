import { execFileSync } from 'node:child_process'

export interface CommandExecutor {
  execute(command: string, args: readonly string[]): string
}

class ProcessCommandExecutor implements CommandExecutor {
  execute(command: string, args: readonly string[]): string {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

export class AdbClient {
  readonly #executor: CommandExecutor
  readonly #serial?: string

  constructor(executor: CommandExecutor = new ProcessCommandExecutor(), serial?: string) {
    this.#executor = executor
    this.#serial = serial
  }

  runShell(command: string): string {
    return this.#executor.execute('adb', [...this.#targetArgs(), 'shell', command]).trim()
  }

  runServiceCall(service: string, transaction: string, arguments_: readonly string[]): string {
    return this.#executor
      .execute('adb', [
        ...this.#targetArgs(),
        'shell',
        'service',
        'call',
        service,
        transaction,
        ...arguments_,
      ])
      .trim()
  }

  getDeviceList(): string {
    return this.#executor.execute('adb', ['devices', '-l']).trim()
  }

  #targetArgs(): string[] {
    return this.#serial ? ['-s', this.#serial] : []
  }
}