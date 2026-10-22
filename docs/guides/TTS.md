# TTS 语音合成（把文字回复变成语音条）

本桥接支持把 AI 生成的**任意文本**合成为语音并发到 QQ（TTS 音色克隆）。
与「语音库发送」（`docs/guides/VOICE.md`）的区别：语音库发的是**预先准备好的音频文件**，
TTS 发的是**实时合成的音频**——文本内容由 AI 当场决定。

## 架构

```
AI 调用 qq_synthesize_voice(text)
        │
        ▼
qq-bridge  ──HTTP──▶  外部 TTS 服务（你自己部署，见下）
        │                 POST /tts {text, ref} → WAV
        ▼
合成产物落盘 state/tts-cache/（相同文本命中缓存）
        │
        ▼
走 sendVoiceV2 既有发送链路（白名单 / 限流 / 审计 / get_msg 回读确认）
```

**桥接只做「调用 + 发送」，不内置合成引擎。** 任何满足「POST JSON → 返回音频字节」
的 HTTP 服务都能接：GPT-SoVITS、Edge-TTS 代理、阿里云语音合成代理等。

## 配置（config.json）

```json
{
  "socialV2": {
    "tts": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:9880",
      "endpoint": "/tts",
      "voice": "main",
      "lang": "zh",
      "timeoutMs": 120000,
      "maxChars": 200,
      "cacheDir": "state/tts-cache",
      "cacheTtlMs": 86400000,
      "cacheMaxEntries": 200
    },
    "tools": { "synthesizeVoice": true },
    "voice": { "enabled": true }
  }
}
```

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | TTS 总开关。**默认 false**——没配好服务就开，AI 调用只会收到报错 | `false` |
| `baseUrl` | TTS 服务地址（http/https） | `http://127.0.0.1:9880` |
| `endpoint` | 合成端点路径（POST，收 JSON 回音频） | `/tts` |
| `voice` | 音色/参考名，原样传给 TTS 服务的 `ref` 字段 | 空（服务端默认） |
| `timeoutMs` | 合成超时（CPU 推理慢，给足预算） | `120000` |
| `maxChars` | 单次合成文本上限，超了拒绝（长文应走文字） | `200` |
| `cacheDir` | 合成缓存目录（相对仓库根） | `state/tts-cache` |
| `cacheTtlMs` / `cacheMaxEntries` | 缓存过期与上限（惰性清理） | 24h / 200 条 |

另需开启 `socialV2.voice.enabled`（发送链路总闸）与 `socialV2.tools.synthesizeVoice`。

## 参考音频准备（音色克隆路线）

想要「自己的音色」才需要这一节；用现成音色（Edge-TTS 等）可跳过。

**素材要求**（GPT-SoVITS 零样本克隆的硬约束）：
- 干净人声：无背景音乐、无混响、单一说话者（音乐/合唱素材会让韵律带唱腔）
- **3-10 秒**一段，语义完整（一个通顺的句子），配套**逐字转写文本**——文本与音频
  严格对齐是合成质量的前提，错位会直接输出乱音
- 安静环境、离麦近（30-50cm）、正常语速说话

**从录屏/视频提取音轨**（用户手里的素材常见是录屏 mp4）：

```bash
# 提取全部音轨为 32kHz 单声道 wav（-vn = 丢弃画面）
ffmpeg -i 录屏.mp4 -vn -ac 1 -ar 32000 提取.wav

# 听一遍，选一段只有本人说话的区间，剪出 8 秒（-ss 起点 -t 时长）
ffmpeg -i 提取.wav -ss 12.3 -t 8 -ac 1 -ar 32000 参考-8s.wav
```

**转写文本**：把 8 秒片段说的话逐字写成一行（含标点）。可用本地 ASR
（funasr paraformer / whisper）转写后人工校对——校对这步别省，错一个字
都会影响对齐。没有 ASR 就边听边打，8 秒而已。

**多参考融合（可选，提升相似度）**：同一说话人多段参考一起给（如 3 段×6s），
特征取平均更稳。GPT-SoVITS 的服务端配 `aux_ref_audio_paths`；其他引擎按其
文档配置。参考音频与转写配置都放在**你自己的 TTS 服务侧**——qq-bridge 只
透传 `voice` 名字，不接触音频文件。

## TTS 服务接口约定

桥接对你的 TTS 服务发起：

```
POST {baseUrl}{endpoint}
Content-Type: application/json

{ "text": "要合成的话", "ref": "配置里的 voice（可空）" }
```

返回：`audio/wav` 字节流（任何 `content-type: audio/*` 皆可，落盘后交给与语音库
相同的发送链路，SnowLuma 侧完成 SILK 转码）。参考实现见
[GPT-SoVITS api_v2](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)。

## AI 工具

| 工具 | 说明 |
|---|---|
| `qq_synthesize_voice` | 把 text 合成为音色语音发到指定会话。返回 `verified=true` 才代表语音落地 |

工具描述已向模型声明：合成失败/超时**必须改用文字回复**，不得假装已发送；
语音是「开口说话」的强表达，频率受 voice 限流（maxPerMinute/maxPerHour）约束。

## 安全与降级

- 发送复用 `sendVoiceForV2` 全链路：会话令牌、白名单、限流、审计、回读确认一个不少
- TTS 服务不可达/超时 → 502 报错 + 「请改用文字回复」提示，AI 回退纯文字
- `dryRun: true` 只合成不发送，产物路径随响应返回（可本地试听）
- 合成串行排队（CPU TTS 并发只会互相拖慢），相同文本命中缓存不再请求服务

## 验证（dryRun，不发送）

```bash
curl -X POST http://127.0.0.1:3100/api/socialV2/synthesize-voice \
  -H 'content-type: application/json' \
  -H "x-console-token: <控制台令牌>" -H 'x-agent-call: 1' \
  -H "x-agent-token: <会话令牌>" \
  -d '{"key":"group:123456","text":"测试","dryRun":true,"token":"<会话令牌>"}'
```

返回 `ok:true, dryRun:true, file:<wav路径>, duration:<秒>` 即链路健康。

## 已实测环境（贡献者验证记录）

- Windows 11 / Ryzen 7 H 255（8C16T，纯 CPU）/ 16GB
- GPT-SoVITS v2Pro + s1v3 GPT 底模，fp32 CPU 推理
- 22 字中文 ≈ 19-26s 合成（RTF 2.2-3.5），缓存命中 0ms
- 零样本多参考融合（3 段 × 6s 同说话人），主观相似度 ~75%
