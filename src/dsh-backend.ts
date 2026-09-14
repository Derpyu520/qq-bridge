// DSH（DeepSeek Harness）作为 BotBackend 的一个实现。
import { NodeApiClient, unwrap } from './dsh-client.js';
import type { BotBackend, BotEnvelope } from './bot-backend.js';

export class DshBotBackend implements BotBackend {
  readonly kind = 'dsh';
  private readonly api: NodeApiClient;

  constructor(baseUrl: string, timeoutMs?: number) {
    this.api = new NodeApiClient(baseUrl, timeoutMs);
  }

  async describeHost(): Promise<any> {
    await this.api.host.describe({});
  }

  async describeSettings(): Promise<any> {
    return unwrap(await this.api.settings.describe({}), 'settings.describe');
  }

  async listPresets(): Promise<any> {
    return unwrap(await this.api.agentPresets.list({}), 'agentPreset.list');
  }

  async createSession(params: any): Promise<any> {
    return unwrap(await this.api.sessions.create(params), 'session.create');
  }

  async selectModel(params: any): Promise<any> {
    return unwrap(await this.api.sessions.selectModel(params), 'session.selectModel');
  }

  async prompt(params: any): Promise<any> {
    return this.api.sessions.prompt(params);
  }

  async respond(message: any): Promise<any> {
    return this.api.respond(message);
  }

  async createWorkspace(params: any): Promise<any> {
    return unwrap(await this.api.workspace.create(params), 'workspace.create');
  }

  async renameWorkspace(params: any): Promise<any> {
    return this.api.workspace.rename(params);
  }

  async listWorkspaces(): Promise<any> {
    return unwrap(await this.api.workspace.list({}), 'workspace.list');
  }

  async deleteWorkspace(params: any): Promise<any> {
    return this.api.workspace.delete(params);
  }

  async archiveSession(params: any): Promise<any> {
    return this.api.workspace.archiveSession(params);
  }

  subscribeEvents(onOpen?: () => void): AsyncIterable<BotEnvelope> {
    const abort = new AbortController();
    return this.api.events.mux({}, abort.signal, onOpen) as AsyncIterable<BotEnvelope>;
  }
}
