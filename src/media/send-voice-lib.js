// 语音发送共享库 —— 薄转发层（唯一实现在 voice-core.js）。
//
// 为什么保留这个文件：src/bridge.js 与若干测试都 import 它。让各模块**共用同一份**
// 音频解析与 ffprobe 探测逻辑，避免"两份实现各自演化"——那正是行为漂移的高发区。
// 独立工具（上级 voice-tool/ 里的 voice-gui.mjs 与 voice-cli.mjs）经
// `../qq-bridge/src/voice-core.js` 引同一份实现，同样不复制代码。
export {
  AUDIO_EXTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SECONDS,
  isAudioFile,
  formatBytes,
  formatDuration,
  listAudioFiles,
  resolveAudioSource,
  safeJoinLibrary,
  probeAudio,
  inspectAudio,
  describeAudio,
  parseTargetKey,
  sanitizeUploadName,
  uniqueLibraryPath,
  VOLUME_MIN,
  VOLUME_MAX,
  LOUDNESS_TARGETS,
  resolveAudioProcessing,
  resolveFfmpeg,
  processAudioVolume,
  cleanupTemp
} from './voice-core.js';