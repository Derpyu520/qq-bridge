// 桥接项目共享类型定义。

export type AnyRecord = Record<string, any>;

export interface MediaItem {
  kind: string;
  file?: string;
  url?: string;
  faceId?: string;
  subType?: string;
  summary?: string;
}

export interface DshConfig {
  baseUrl: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  [k: string]: any;
}

export interface SnowLumaConfig {
  wsUrl: string;
  accessToken: string;
  httpUrl?: string;
  launcherPath?: string;
  homeDir?: string;
  allowProcessControl?: boolean;
  [k: string]: any;
}

export interface AllowDeny {
  private: string[];
  groups: string[];
}

export interface SecurityConfig {
  interceptNotify: boolean;
  [k: string]: any;
}

export interface SlangConfig {
  enabled: boolean;
  extractMinMessages: number;
  extractCooldownMs: number;
  inferenceThresholds: number[];
  injectMax: number;
  learnerPreset: string;
  workspaceTitle: string;
  autoResearch: boolean;
  [k: string]: any;
}

export interface SocialConfig {
  enabled: boolean;
  triggerProbability: number;
  contextWindow: number;
  activeCheckMinMs: number;
  activeCheckMaxMs: number;
  activeReplyDelayMinMs: number;
  activeReplyDelayMaxMs: number;
  activeDurationEnabled: boolean;
  activeDurationMinMs: number;
  activeDurationMaxMs: number;
  idleWindowMs: number;
  idleRetryProbability: number;
  idleRetryWaitMs: number;
  proactiveEnabled: boolean;
  proactiveIdleThresholdMs: number;
  proactiveCheckMinMs: number;
  proactiveCheckMaxMs: number;
  proactiveProbability: number;
  skipProbability: number;
  surrenderProbability: number;
  maxReplyChars: number;
  mustReplyKeywords: string[];
  burstEnabled: boolean;
  burstIntervalMinMs: number;
  burstIntervalMaxMs: number;
  longGapProbability: number;
  longGapMinMs: number;
  longGapMaxMs: number;
  [k: string]: any;
}

export interface SocialV2Config {
  enabled: boolean;
  autoReplyCheckMs: number;
  agentPreset: string;
  provideRecommendations: boolean;
  tools: Record<string, boolean>;
  wake: Record<string, any>;
  send: Record<string, any>;
  wait: Record<string, any>;
  sticker: Record<string, any>;
  proactive: Record<string, any>;
  feedback: Record<string, any>;
  context: Record<string, any>;
  [k: string]: any;
}

export interface Config {
  dsh: DshConfig;
  snowluma: SnowLumaConfig;
  sessionCwd: string;
  agentPreset: string;
  workspaceTitle: string;
  ownerQQ: number | null;
  allow: AllowDeny;
  deny: AllowDeny;
  allowAllWhenEmpty: boolean;
  ackMessage: string;
  sendDelayMs: number;
  questionTimeoutMs: number;
  consolePort: number;
  consoleToken: string;
  security: SecurityConfig;
  slang: SlangConfig;
  social: SocialConfig;
  socialV2: SocialV2Config;
}

export interface BridgeState {
  sessions: Record<string, string>;
}

export interface SegmentsToTextOptions {
  resolveAtName?: ((qq: string) => Promise<string | null>) | null;
  resolveReply?: ((messageId: string) => Promise<{ sender?: string; text?: string; userId?: string | null } | null>) | null;
  includeReply?: boolean;
}

export interface SocialState {
  phase: 'idle' | 'active' | 'probing' | 'exiting';
  lastCheckAt: number;
  nextCheckAt: number;
  lastActiveMessageAt: number;
  activeEnteredAt: number;
  activeDeadlineAt: number;
  activeExitAt: number;
  lastAiReplyAt: number;
  lastFollowUpAt: number;
  probeDeadline: number;
  proactiveNextCheckAt: number;
}

export interface RecentMessage {
  sender: string;
  text: string;
  plain: string;
  quoteTargetIsSelf: boolean;
  isOwner: boolean;
  media: MediaItem[];
  messageId: string;
  hasMedia: boolean;
  time: number;
}

export interface SummaryItem {
  sender: string;
  text: string;
  plain: string;
  isOwner: boolean;
  media: MediaItem[];
  messageId: string;
  hasMedia: boolean;
  time: number;
}

export interface WakeTriggers {
  atMention: boolean;
  nameMention: boolean;
  speakerIds: string[];
  keywords: string[];
  question: boolean;
  poke: boolean;
  anyMessage: boolean;
  probability: number;
}

export interface WakeConfig {
  mode: 'diving' | 'active';
  infinite: boolean;
  sleepUntil: string | null;
  triggers: WakeTriggers;
  batchWindowMs: number;
  lastWakeAt: number;
  wakeCount: number;
  noActionCount: number;
  confirmedAt: number;
  confirmedBy: string;
}

export interface V2Message {
  seq: number;
  messageId: string | null;
  sender: string;
  userId: string | null;
  text: string;
  plain: string;
  tail: string;
  kind?: string;
  quoteTargetIsSelf: boolean;
  isOwner: boolean;
  ownerLabel: string;
  isSelf: boolean;
  media: MediaItem[];
  hasMedia: boolean;
  forwardIds: string[];
  hasForward: boolean;
  poke?: any;
  sticker?: any;
  time: number;
}

export interface SocialV2State {
  wakeConfig: WakeConfig;
  recentMessages: V2Message[];
  unread: V2Message[];
  lastWakeReason: string;
  lastAiReplyAt: number;
  lastActionAt: number;
  agentToken: string;
  bootstrapSent: boolean;
  wakeTimes: number[];
  sendTimes: number[];
  stickerCollectTimes: number[];
  pendingWakeTimer: ReturnType<typeof setTimeout> | null;
  pendingWakeReason?: string | null;
  pendingWakeReasons?: { reason: string; seq: number }[];
  sleepTimer: ReturnType<typeof setTimeout> | null;
  replyCheckTimer: ReturnType<typeof setTimeout> | null;
  proactiveTimer: ReturnType<typeof setTimeout> | null;
  lastIncomingAt: number;
  preSleepWaitSatisfiedAt: number;
  preSleepWaitObservedAt: number;
  preSleepWaitAccumMs: number;
  lastUnreadSeq: number;
  activeTopics: any[];
  pendingThoughts: any[];
  memberImpressions: Record<string, any>;
  key?: string;
}
