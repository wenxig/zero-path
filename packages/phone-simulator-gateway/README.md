# Phone Simulator Gateway

局域网 MCP 与 Android 设备网关。MCP 使用 Streamable HTTP，Android 使用出站 WebSocket，因此手机不需要监听端口。

## 启动

正式局域网测试必须配置 TLS。`SIMULATOR_DEVICE_ID` 显示在 Android 应用首页，两个 token 必须不同。

```sh
SIMULATOR_DEVICE_ID=android-device-id \
SIMULATOR_TOKEN=replace-device-token \
MCP_TOKEN=replace-mcp-token \
TLS_CERT_PATH=/absolute/path/to/certificate.pem \
TLS_KEY_PATH=/absolute/path/to/private-key.pem \
vp run -F @zero-path/phone-simulator-gateway dev
```

默认端点：

- `https://0.0.0.0:8787/mcp`
- `wss://0.0.0.0:8787/device`
- `https://0.0.0.0:8787/health`

MCP 请求使用 `Authorization: Bearer <MCP_TOKEN>`。Android 在 WebSocket Upgrade 阶段使用 `SIMULATOR_TOKEN`，网关同时校验固定的设备 ID。

仅在隔离的开发网络中，可显式设置 `ALLOW_INSECURE_HTTP=true` 启用 `http://` 和 `ws://`。Android 端也必须单独启用明文 LAN 开发选项。

## MCP 工具

- `list_simulators`
- `get_audio_state`
- `start_audio_upload`
- `stop_audio_upload`
- `start_audio_download`
- `stop_audio_download`
- `set_simulation_mode`
- `arm_shell`
- `execute_shell`

`execute_shell` 只在同一个 MCP 会话内调用 `arm_shell` 并通过 Android 本地 PIN 验证后可用。命令运行在应用沙箱权限下，输出限制为 64 KiB，授权有效期为 15 分钟；Android 与网关都会限制 PIN 尝试频率。

当前版本不加载模型或语音服务。GPT Realtime、文本模型协调、STT 和 TTS 均保留为后续能力。
