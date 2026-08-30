// Bot 后端抽象：桥接把「会话创建 / prompt 投递 / 模型选择 / 事件订阅 / 应答」等能力
// 都收敛到这个接口后面，DSH 只是其中一个实现，便于替换或注入 mock 做单元测试。

export interface BotEvent {
  type: string;
  sessionId?: string;
  event?: any;
  questions?: any[];
  approvalId?: string;
  toolName?: string;
  reason?: string;
  error?: any;
  [k: string]: any;
}

export interface BotEnvelope {
  rpcId: unknown;
  payload: BotEvent;
}

export interface BotBackend {
  readonly kind: string;
  /** 探活：后端不可用时应抛错。 */
  describeHost(): Promise<any>;
  /** 读取后端 settings（用于桥接模式刷新）。 */
  describeSettings(): Promise<any>;
  /** 列出 agent presets。 */
  listPresets(): Promise<any>;
  /** 创建会话，返回含 sessionId 的结果。 */
  createSession(params: any): Promise<any>;
  /** 选择会话模型（如视觉模型）。 */
  selectModel(params: any): Promise<any>;
  /** 投递 prompt，返回 acceptance 结果（含 result 槽）。 */
  prompt(params: any): Promise<any>;
  /** 应答后端发起的 question / approval 请求。 */
  respond(message: any): Promise<any>;
  createWorkspace(params: any): Promise<any>;
  renameWorkspace(params: any): Promise<any>;
  listWorkspaces(): Promise<any>;
  deleteWorkspace(params: any): Promise<any>;
  archiveSession(params: any): Promise<any>;
  /** 订阅后端下行事件流。 */
  subscribeEvents(onOpen?: () => void): AsyncIterable<BotEnvelope>;
}
