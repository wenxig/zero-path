# ESP32 HFP 电话音频桥接实施计划

## 目标

使用现有 `ESP32-WROOM-32E` 开发板，把华为 `DVC-AN00` 的蜂窝通话音频通过 Bluetooth Classic HFP/SCO 双向桥接到 macOS，为后续本地 ASR、总台 AI 和 TTS 提供实时 PCM 音频。

```text
中国移动来电
  ↕
华为 DVC-AN00（HarmonyOS 3 / Android 10）
  ↕ Bluetooth Classic HFP / SCO
ESP32-WROOM-32E
  ↕ CH340 USB 串口
macOS
  ↕
VAD / ASR / 总台 AI / TTS
```

## 已验证事实

- 手机可通过 ADB 监控真实来电状态。
- Android 10 Telecom binder 事务 `31` 可自动接听，状态能够从 `RINGING` 转为 `ACTIVE`。
- 手机未 Root，SELinux 为 `Enforcing`。
- ADB shell 无权访问通话 PCM 设备，活动通话期间 `tinycap` 仍返回 `Permission denied`。
- 纯 ADB 通话音频捕获与上行注入不可行。
- 开发板模块为乐鑫 `ESP32-WROOM-32E`，支持 Bluetooth Classic BR/EDR 和 HFP。
- 开发板通过 CH340 连接 macOS，串口为 `/dev/cu.wchusbserial1420`。

## 技术选型

### ESP32 固件

使用 **C++26 + ESP-IDF**：

- ESP-IDF C API 负责 Bluetooth GAP、HFP、SCO、UART、NVS 和看门狗。
- 使用薄 C 回调接收 ESP-IDF 事件。
- 使用 C++ 类组织状态机、缓冲区、串口协议和生命周期。
- 只使用 ESP-IDF 官方 `esp-clang` 工具链，不提供 GCC/MSVC/AppleClang 兼容层，也不使用 Arduino、MicroPython、TinyGo、ESP-TypeScript 或 Rust ESP 绑定。
- 实现代码通常使用 `auto` 做局部类型推导，并优先使用捕获明确的 lambda 表达短生命周期回调和局部策略。

必须启用的 HFP HCI 数据路径：

```text
CONFIG_BT_HFP_AUDIO_DATA_PATH_HCI=y
CONFIG_BTDM_CTRL_BR_EDR_SCO_DATA_PATH_HCI=y
```

### macOS 端

分两步实现：

1. 使用 C++26 编写最小串口验证程序，和共享协议库一起验证配对、事件和 PCM 数据。
2. 双工音频稳定后，继续使用 C++26 实现长期运行的串口音频守护进程；TypeScript 只负责高层 AI 编排。

现有 TypeScript `tel-core` 继续负责 ADB、通话状态和高层编排。Clang 编译的 C++26 进程负责串口、二进制分帧、抖动缓冲、重采样和 PCM 管道。

## ESP32 模块划分

```text
firmware/
├── app_main.cpp
├── bluetooth/
│   ├── HfpClient.cpp
│   ├── HfpEvents.cpp
│   └── PairingStore.cpp
├── audio/
│   ├── ScoAudioBridge.cpp
│   ├── DownlinkBuffer.cpp
│   └── UplinkBuffer.cpp
├── transport/
│   ├── SerialTransport.cpp
│   ├── FrameCodec.cpp
│   └── Protocol.cpp
└── runtime/
    ├── CallStateMachine.cpp
    ├── HeartbeatSupervisor.cpp
    └── WatchdogSupervisor.cpp
```

核心类职责：

- `HfpClient`：配对、重连、SLC/SCO 状态及 HFP 事件。
- `ScoAudioBridge`：SCO 上下行音频回调与环形缓冲区。
- `SerialTransport`：UART 双向传输、背压和统计。
- `FrameCodec`：COBS 或 SLIP 分帧以及 CRC 校验。
- `CallStateMachine`：来电、接通、活动、挂断状态转换。
- `HeartbeatSupervisor`：只在 Mac 守护进程在线时允许接听。
- `WatchdogSupervisor`：检测任务阻塞、缓冲停滞和蓝牙异常。

## 实时音频约束

- 第一版固定使用 CVSD、8 kHz、16-bit、单声道 PCM。
- UART 初始波特率使用 `921600`。
- HFP 回调不得阻塞、写日志、访问文件或动态分配大块内存。
- 回调只把数据写入预分配环形缓冲区。
- UART TX/RX 分别使用独立 FreeRTOS 任务。
- 控制帧优先于音频帧，避免通话状态被 PCM 队列阻塞。
- 记录 RX/TX 帧数、丢帧、缓冲水位、CRC 错误和 SCO 重连次数。

## 串口协议草案

每个逻辑帧使用 COBS 或 SLIP 编码：

```text
version | type | sequence | timestamp | payload_length | payload | crc32
```

首批消息类型：

```text
HELLO
HEARTBEAT
PAIRING_STATE
CALL_STATE
SCO_STATE
AUDIO_DOWNLINK
AUDIO_UPLINK
AUDIO_STATS
ERROR
```

固件不实现以下命令：

```text
DIAL
REDIAL
SEND_SMS
USSD
```

## 禁止外呼与安全边界

- 固件不编译、不注册、不暴露拨号和重拨接口。
- Mac 协议不存在外呼消息类型。
- 第一阶段继续由已验证的 ADB Telecom 控制器自动接听。
- ESP32 仅承载 HFP 音频和通话状态，不主动控制拨号。
- 后续若迁移到 HFP 自动接听，只允许 `answer`、`reject` 和 `hang-up`。
- Mac 心跳丢失时不得自动接听新来电。
- 配对设备地址保存在 NVS，只自动重连已授权手机。

## 分阶段实验

### 阶段 1：固件与工具链

- 建立独立 ESP-IDF 固件目录和构建任务。
- 固定 `ESP-IDF v6.0.2`、`esp-clang 20.1.1`、CMake 和 Ninja 版本。
- 主机端固定 Homebrew LLVM Clang、C++26、CMake Presets 和 Ninja；配置阶段拒绝其他编译器。
- 使用 vcpkg manifest 管理主机依赖，使用 ESP Component Manager 管理固件依赖。
- 使用 Clang-Tidy、Clang-Format、ccache 和 Sanitizer 作为默认开发工具。
- 确认芯片、Flash、MAC 地址和可用堆内存。
- 验证 `921600` UART 持续双向数据传输。
- 验证看门狗、重启和串口重新连接。

验收条件：连续传输 30 分钟，无 CRC 错误、死锁或异常重启。

### 阶段 2：HFP 控制链路

- 从 ESP-IDF 官方 `hfp_hf` 示例裁剪最小固件。
- 手机发现并配对 ESP32。
- 保存配对信息并在 ESP32 重启后自动重连。
- 向 Mac 上报来电、活动和挂断事件。

验收条件：连续进行 10 次来电，HFP SLC 均能建立和恢复。

### 阶段 3：SCO 下行

- 启用 Voice over HCI。
- 建立 SCO 后把下行 PCM 写入串口。
- Mac 保存为 WAV，检查采样率、幅度、连续性和语音可懂度。

验收条件：Mac 能录到远端讲话，连续 5 分钟无明显断音。

### 阶段 4：SCO 上行

- Mac 发送固定 8 kHz PCM 测试音或语音。
- ESP32 通过 HFP 上行发送到电话。
- 检查音量、削波、帧丢失和端到端延迟。

验收条件：呼叫端可以稳定听清测试语音，且无持续爆音或卡顿。

### 阶段 5：全双工与打断

- 同时启用上下行 PCM。
- 加入抖动缓冲和背压策略。
- 测量下行到 ASR、TTS 到上行的端到端延迟。
- 验证 TTS 播放期间仍可检测呼叫端讲话并立即停止上行 TTS。

验收条件：连续通话 15 分钟，双向无失联，打断响应目标低于 500 ms。

### 阶段 6：无人值守

- ESP32 自动重连已配对手机。
- macOS 使用 `launchd` 管理守护进程。
- 手机、ESP32、Mac 任一重启后能够自动恢复。
- 增加状态日志、错误计数和健康检查。

验收条件：完成手机、ESP32、Mac 分别重启后的恢复测试，并运行 24 小时。

## 暂不实施

- 暂不启用 mSBC 16 kHz。
- 暂不接入 ASR、LLM 和 TTS。
- 暂不把 ESP32 自动接听作为唯一接听路径。
- 暂不实现 macOS 虚拟声卡。
- 暂不购买外置 I2S ADC/DAC；HCI PCM 直接走串口。

## 下一步指令后的首项工作

收到继续指令后，从阶段 1 开始：检查本机是否已有 ESP-IDF 工具链，读取 ESP32 芯片与 Flash 信息，然后建立最小固件目录。未经明确指令，不烧录开发板、不修改手机蓝牙配对、不启动新的通话实验。
