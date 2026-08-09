import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import { WebSocketServer } from 'ws'

import { DeviceRegistry } from './device-registry.ts'
import { createMcpServer, handleMcpRequest, type McpHttpSession } from './mcp-server.ts'
import { isDeviceInboundMessage } from './protocol.ts'

const port = parsePositiveInteger(process.env.PORT ?? '8787', 'PORT')
const host = process.env.HOST ?? '0.0.0.0'
const simulatorToken = requiredEnvironment('SIMULATOR_TOKEN')
const simulatorDeviceId = requiredEnvironment('SIMULATOR_DEVICE_ID')
const mcpToken = requiredEnvironment('MCP_TOKEN')
if (safeTokenEquals(simulatorToken, mcpToken)) {
  throw new Error('MCP_TOKEN must be different from SIMULATOR_TOKEN')
}

const tlsCertificatePath = process.env.TLS_CERT_PATH
const tlsKeyPath = process.env.TLS_KEY_PATH
const allowInsecureHttp = process.env.ALLOW_INSECURE_HTTP === 'true'
if (!!tlsCertificatePath !== !!tlsKeyPath) {
  throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together')
}
if (!tlsCertificatePath && !allowInsecureHttp) {
  throw new Error(
    'TLS is required; configure TLS_CERT_PATH/TLS_KEY_PATH or explicitly set ALLOW_INSECURE_HTTP=true for development',
  )
}

const registry = new DeviceRegistry({ token: simulatorToken, deviceId: simulatorDeviceId })
const sessions = new Map<string, McpHttpSession>()
const requestListener: RequestListener = async (request, response) => {
  const path = request.url?.split('?')[0]
  if (path === '/health') {
    writeJson(response, 200, { status: 'ok' })
    return
  }

  const authorization = bearerToken(request)
  if (!authorization || !safeTokenEquals(authorization, mcpToken)) {
    writeJson(response, 401, { error: 'unauthorized' })
    return
  }

  try {
    if (path === '/mcp') {
      await handleMcpRequest(request, response, sessions, () => createMcpServer(registry))
      return
    }
    writeJson(response, 404, { error: 'not found' })
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else {
      response.end()
    }
  }
}

const secure = !!tlsCertificatePath && !!tlsKeyPath
const server = secure
  ? createHttpsServer(
      {
        cert: readFileSync(tlsCertificatePath),
        key: readFileSync(tlsKeyPath),
        minVersion: 'TLSv1.2',
      },
      requestListener,
    )
  : createHttpServer(requestListener)
server.requestTimeout = 15_000
server.headersTimeout = 10_000
server.keepAliveTimeout = 5_000
const deviceServer = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
})
const authorizedDevices = new WeakMap<IncomingMessage, string>()

server.on('upgrade', (request, socket, head) => {
  if (request.url?.split('?')[0] !== '/device') {
    rejectUpgrade(socket, 404, 'Not Found')
    return
  }
  if (deviceServer.clients.size >= MAX_DEVICE_CONNECTIONS) {
    rejectUpgrade(socket, 503, 'Device connection limit reached')
    return
  }
  const token = bearerToken(request)
  const deviceIdHeader = request.headers['x-zero-path-device-id']
  const deviceId = typeof deviceIdHeader === 'string' ? deviceIdHeader : ''
  if (!token || !registry.authenticateCredentials(token, deviceId)) {
    rejectUpgrade(socket, 401, 'Unauthorized')
    return
  }
  authorizedDevices.set(request, deviceId)
  deviceServer.handleUpgrade(request, socket, head, webSocket =>
    deviceServer.emit('connection', webSocket, request),
  )
})

deviceServer.on('connection', (socket, request) => {
  const authorizedDeviceId = authorizedDevices.get(request)
  authorizedDevices.delete(request)
  if (!authorizedDeviceId) {
    socket.terminate()
    return
  }
  let deviceId: string | undefined
  let authenticated = false
  const authTimer = setTimeout(() => {
    if (!authenticated) socket.terminate()
  }, 5_000)

  socket.on('message', data => {
    let message: unknown
    try {
      message = JSON.parse(data.toString())
    } catch {
      socket.close(4002, 'invalid JSON')
      return
    }
    if (!isDeviceInboundMessage(message)) {
      socket.close(4002, 'invalid device message')
      return
    }

    if (!authenticated) {
      if (!registry.authenticateHello(message, authorizedDeviceId)) {
        socket.close(4003, 'authentication failed')
        return
      }
      authenticated = true
      clearTimeout(authTimer)
      deviceId = message.deviceId
      registry.register(socket, message)
      socket.send(JSON.stringify({ kind: 'hello_ack', deviceId: message.deviceId }))
      return
    }

    registry.handleMessage(deviceId as string, socket, message)
  })
  socket.on('close', () => {
    clearTimeout(authTimer)
    if (deviceId) registry.unregister(deviceId, socket)
  })
  socket.on('error', () => {
    if (deviceId) registry.unregister(deviceId, socket)
  })
})

server.listen(port, host, () => {
  const httpProtocol = secure ? 'https' : 'http'
  const webSocketProtocol = secure ? 'wss' : 'ws'
  console.log(`phone simulator gateway listening on ${httpProtocol}://${host}:${port}`)
  console.log(`MCP endpoint: ${httpProtocol}://${host}:${port}/mcp`)
  console.log(`Android device endpoint: ${webSocketProtocol}://${host}:${port}/device`)
})

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: number,
  message: string,
): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return parsed
}

function writeJson(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const MAX_DEVICE_CONNECTIONS = 16