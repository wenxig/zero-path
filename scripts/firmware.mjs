#!/usr/bin/env node

// cspell:ignore deinit espcoredump

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolsDir = join(rootDir, '.tools')
const managedIdfDir = join(toolsDir, 'esp-idf')
const projectDir = join(rootDir, 'packages', 'esp32-hfp')
const idfVersion = 'v6.0.2'

const python = findPython()

function formatCommand(command, args) {
  return [command, ...args]
    .map(value => (value.includes(' ') ? JSON.stringify(value) : value))
    .join(' ')
}

function run(command, args, options = {}) {
  console.log(`> ${formatCommand(command, args)}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    if (options.allowFailure) return false
    throw new Error(`Command failed with exit code ${result.status ?? 1}`)
  }
  return true
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? 1}`)
  return result.stdout
}

function findPython() {
  const candidates = process.env.ESP_PYTHON
    ? [{ command: process.env.ESP_PYTHON, args: [] }]
    : process.platform === 'win32'
      ? [
          { command: 'py', args: ['-3'] },
          { command: 'python', args: [] },
          { command: 'python3', args: [] },
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] },
        ]

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return candidate
  }

  throw new Error('Python 3 is unavailable')
}

function runPython(script, args, options = {}) {
  run(python.command, [...python.args, script, ...args], options)
}

function getEnvironmentValue(env, name) {
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function expandEnvironmentValue(value, env) {
  return value.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g,
    (match, braced, plain, windows) => {
      return getEnvironmentValue(env, braced ?? plain ?? windows) ?? match
    },
  )
}

function getIdfEnvironment(idfDir) {
  const idfTools = join(idfDir, 'tools', 'idf_tools.py')
  const env = { ...process.env, IDF_PATH: idfDir, IDF_TOOLCHAIN: 'clang' }
  const extraPaths = ['espcoredump', 'partition_table', 'app_update']
    .map(component => join(idfDir, 'components', component))
    .join(delimiter)

  const output = capture(
    python.command,
    [...python.args, idfTools, 'export', '--format', 'key-value', '--add_paths_extras', extraPaths],
    { env },
  )

  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const name = line.slice(0, separator)
    const value = expandEnvironmentValue(line.slice(separator + 1), env)
    const oldKey = Object.keys(env).find(
      candidate => candidate.toLowerCase() === name.toLowerCase(),
    )
    if (oldKey && oldKey !== name) delete env[oldKey]
    env[name] = value
  }

  env.IDF_PATH = idfDir
  env.IDF_TOOLCHAIN = 'clang'
  return env
}

function getIdfPython(env) {
  const pythonEnv = env.IDF_PYTHON_ENV_PATH
  if (!pythonEnv)
    throw new Error('ESP-IDF Python environment is unavailable; run firmware:bootstrap first')

  const executable =
    process.platform === 'win32'
      ? join(pythonEnv, 'Scripts', 'python.exe')
      : join(pythonEnv, 'bin', 'python')
  if (!existsSync(executable))
    throw new Error(`ESP-IDF Python executable is unavailable: ${executable}`)
  return executable
}

function bootstrap() {
  mkdirSync(toolsDir, { recursive: true })
  if (!existsSync(join(managedIdfDir, '.git'))) {
    run('git', [
      'clone',
      '--depth=1',
      '--branch',
      idfVersion,
      'https://github.com/espressif/esp-idf.git',
      managedIdfDir,
    ])
  }

  run('git', ['-C', managedIdfDir, 'fetch', '--depth=1', 'origin', idfVersion])
  run('git', ['-C', managedIdfDir, 'checkout', '--detach', idfVersion])
  run('git', ['-C', managedIdfDir, 'submodule', 'sync', '--recursive'])
  const submodulesUpdated = run(
    'git',
    ['-C', managedIdfDir, 'submodule', 'update', '--init', '--recursive', '--depth=1'],
    { allowFailure: true },
  )
  if (!submodulesUpdated) {
    run('git', ['-C', managedIdfDir, 'submodule', 'deinit', '-f', '--all'])
    run('git', ['-C', managedIdfDir, 'submodule', 'update', '--init', '--recursive', '--depth=1'])
  }

  const env = { ...process.env, IDF_PATH: managedIdfDir }
  const idfTools = join(managedIdfDir, 'tools', 'idf_tools.py')
  runPython(idfTools, ['install', '--targets=esp32'], { env })
  runPython(idfTools, ['install-python-env', '--features=core'], { env })
  runPython(idfTools, ['install', 'esp-clang', 'esp-clang-libs'], { env })

  console.log(`ESP-IDF ${idfVersion} installed at ${managedIdfDir}`)
}

function runFirmware(action) {
  const idfDir = resolve(process.env.IDF_PATH ?? managedIdfDir)
  const idfPy = join(idfDir, 'tools', 'idf.py')
  const idfTools = join(idfDir, 'tools', 'idf_tools.py')
  if (!existsSync(idfPy) || !existsSync(idfTools)) {
    throw new Error('ESP-IDF is unavailable; run vp run firmware:bootstrap first')
  }

  const commands = { configure: ['set-target', 'esp32'], build: ['build'], lint: ['clang-check'] }
  const args = commands[action]
  if (!args) throw new Error('Usage: firmware.mjs {bootstrap|configure|build|lint}')

  const env = getIdfEnvironment(idfDir)
  run(getIdfPython(env), [idfPy, '-C', projectDir, ...args], { env })
}

try {
  const action = process.argv[2]
  if (action === 'bootstrap') bootstrap()
  else runFirmware(action)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}