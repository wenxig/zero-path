import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { DeviceRegistry, ShellAuthorization } from './device-registry.ts'

export function createMcpServer(registry: DeviceRegistry): McpServer {
  const server = new McpServer({ name: 'zero-path-phone-simulator', version: '1.0.0' })
  const shellAuthorizations = new Map<string, ShellAuthorization>()
  const deviceId = z.string().min(1).max(128)

  server.registerTool(
    'list_simulators',
    { description: '列出已连接的 Android 电话模拟器', inputSchema: {} },
    async () => textResult(registry.list()),
  )
  server.registerTool(
    'get_audio_state',
    { description: '读取 Android 电话模拟器当前的传输状态和音频帧统计', inputSchema: { deviceId } },
    async ({ deviceId }) => invoke(registry, deviceId, { name: 'get_state' }),
  )
  server.registerTool(
    'start_audio_upload',
    {
      description: '从 Android 向 ESP32 上传 8 kHz 16-bit 单声道 PCM 测试音频',
      inputSchema: {
        deviceId,
        fixture: z.enum(['silence', 'tone-440']),
        durationMs: z.number().int().min(100).max(3_600_000).default(10_000),
      },
    },
    async ({ deviceId, fixture, durationMs }) =>
      invoke(registry, deviceId, { name: 'start_audio_upload', fixture, durationMs }),
  )
  server.registerTool(
    'stop_audio_upload',
    { description: '停止 Android 到 ESP32 的 PCM 上传', inputSchema: { deviceId } },
    async ({ deviceId }) => invoke(registry, deviceId, { name: 'stop_audio_upload' }),
  )
  server.registerTool(
    'start_audio_download',
    {
      description: '让 Android 从 ESP32 下载并校验 PCM 测试音频',
      inputSchema: {
        deviceId,
        durationMs: z.number().int().min(100).max(3_600_000).default(10_000),
      },
    },
    async ({ deviceId, durationMs }) =>
      invoke(registry, deviceId, { name: 'start_audio_download', durationMs }),
  )
  server.registerTool(
    'stop_audio_download',
    { description: '停止 ESP32 到 Android 的 PCM 下载', inputSchema: { deviceId } },
    async ({ deviceId }) => invoke(registry, deviceId, { name: 'stop_audio_download' }),
  )
  server.registerTool(
    'set_simulation_mode',
    {
      description: '确认使用 SPP 帧协议音频测试模式',
      inputSchema: { deviceId, mode: z.literal('protocol') },
    },
    async ({ deviceId, mode }) => invoke(registry, deviceId, { name: 'set_simulation_mode', mode }),
  )
  server.registerTool(
    'arm_shell',
    {
      description: '使用 Android 本地配置的 PIN 临时启用任意 shell 命令执行',
      inputSchema: { deviceId, pin: z.string().min(8).max(64) },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ deviceId, pin }) => {
      try {
        const authorization = await registry.armShell(deviceId, pin)
        shellAuthorizations.set(deviceId, authorization)
        return textResult({ expiresAt: authorization.expiresAt })
      } catch (error) {
        return errorResult(error)
      }
    },
  )
  server.registerTool(
    'execute_shell',
    {
      description:
        '在已通过 PIN 验证的 Android 应用沙箱中执行任意 shell 命令。授权断线或过期后必须重新验证 PIN。',
      inputSchema: {
        deviceId,
        command: z.string().min(1).max(20_000),
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ deviceId, command, timeoutMs }) => {
      try {
        return textResult(
          await registry.executeShell(
            deviceId,
            command,
            shellAuthorizations.get(deviceId),
            timeoutMs,
          ),
        )
      } catch (error) {
        if (error instanceof Error && /not armed|expired|invalid shell/i.test(error.message)) {
          shellAuthorizations.delete(deviceId)
        }
        return errorResult(error)
      }
    },
  )

  return server
}

export type McpHttpSession = {
  transport: StreamableHTTPServerTransport
  server: McpServer
  expiryTimer?: ReturnType<typeof setTimeout>
}

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, McpHttpSession>,
  createServer: () => McpServer,
): Promise<void> {
  const rawSessionId = request.headers['mcp-session-id']
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined
  const existing = sessionId ? sessions.get(sessionId) : undefined
  const body = request.method === 'POST' ? await readJsonBody(request, response) : undefined
  if (request.method === 'POST' && body === INVALID_BODY) return

  if (sessionId && !existing) {
    writeJsonRpcError(response, 404, 'MCP session not found')
    return
  }

  if (!sessionId && request.method === 'POST' && isInitializeRequest(body)) {
    if (sessions.size >= MAX_MCP_SESSIONS) {
      writeJsonRpcError(response, 429, 'Too many MCP sessions')
      return
    }
    const server = createServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        const session = { transport, server }
        sessions.set(id, session)
        refreshSession(id, session, sessions)
      },
      onsessionclosed: id => {
        void disposeSession(id, sessions)
      },
    })
    transport.onclose = () => {
      if (transport.sessionId) void disposeSession(transport.sessionId, sessions)
    }
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      await server.close()
      throw error
    }
    return
  }

  if (!existing) {
    writeJsonRpcError(response, 400, 'A valid MCP session or initialize request is required')
    return
  }

  refreshSession(sessionId as string, existing, sessions)
  await existing.transport.handleRequest(request, response, body)
  if (request.method === 'DELETE') {
    await disposeSession(sessionId as string, sessions)
  }
}

function invoke(
  registry: DeviceRegistry,
  deviceId: string,
  command: Parameters<DeviceRegistry['invoke']>[1],
) {
  return registry
    .invoke(deviceId, command)
    .then(data => textResult(data))
    .catch(error => ({
      isError: true,
      content: [
        { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
      ],
    }))
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) ?? 'null' }] }
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
  }
}

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof INVALID_BODY> {
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES) {
    writeJsonRpcError(response, 413, 'MCP request body is too large')
    request.resume()
    return INVALID_BODY
  }
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (status: number, message: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (!response.headersSent) writeJsonRpcError(response, status, message)
      request.resume()
      resolve(INVALID_BODY)
    }
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_MCP_BODY_BYTES) {
        fail(413, 'MCP request body is too large')
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        writeJsonRpcError(response, 400, 'Invalid MCP JSON request')
        resolve(INVALID_BODY)
      }
    }
    const onError = () => fail(400, 'Invalid MCP JSON request')
    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

function refreshSession(
  sessionId: string,
  session: McpHttpSession,
  sessions: Map<string, McpHttpSession>,
): void {
  if (session.expiryTimer) clearTimeout(session.expiryTimer)
  session.expiryTimer = setTimeout(() => {
    void disposeSession(sessionId, sessions)
  }, MCP_SESSION_IDLE_MS)
  session.expiryTimer.unref()
}

async function disposeSession(
  sessionId: string,
  sessions: Map<string, McpHttpSession>,
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.expiryTimer) clearTimeout(session.expiryTimer)
  await session.server.close()
}

function writeJsonRpcError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message }, id: null }))
}

const INVALID_BODY = Symbol('invalid MCP body')
const MAX_MCP_BODY_BYTES = 1024 * 1024
const MAX_MCP_SESSIONS = 32
const MCP_SESSION_IDLE_MS = 15 * 60 * 1_000