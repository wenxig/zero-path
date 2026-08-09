# Android Phone Simulator

Kotlin 原生 Android 应用，用于在不产生蜂窝通话费用的情况下测试 ESP32 音频上传和下载。

## 当前范围

- Bluetooth Classic SPP，与 `Zero Path Audio Test` 服务通信。
- 上传 8 kHz、16-bit、单声道 PCM 静音或 440 Hz 测试音。
- 下载 ESP32 生成的 440 Hz PCM，并保存为应用外部文件目录中的 WAV。
- 通过局域网 WebSocket 接收 MCP 网关命令并上报帧统计。
- 本地 PIN 验证后，可在 Android 应用沙箱内执行任意 shell 命令。

当前不接入 GPT Realtime、文本模型、STT、TTS、蜂窝拨号或真实通话控制。

## 构建

```sh
./gradlew testDebugUnitTest assembleDebug
```

APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。

## 使用

1. 烧录 `@zero-path/esp32-hfp` 固件。
2. 在 Android 蓝牙设置中配对 `Zero Path Audio Test`，蓝牙 PIN 为 `1234`。
3. 在应用中连接 ESP32，运行上传或下载测试。
4. 需要局域网控制时，把首页显示的 Device ID 配置为网关的 `SIMULATOR_DEVICE_ID`，填写 `wss://` URL 和 `SIMULATOR_TOKEN` 后启动网关服务。

Bluetooth PIN 只用于设备配对。shell PIN 在 Android 应用中单独设置，必须为 8 至 64 个字符；应用使用 PBKDF2 保存验证值并对失败尝试进行持久化指数锁定。授权有效 15 分钟，断开网关后服务端授权状态立即清除。

应用默认拒绝明文 `ws://`。只有在隔离的开发网络中，才应同时启用应用内的明文 LAN 开关和网关的 `ALLOW_INSECURE_HTTP=true`。
