const OPEN = 1;
const CLOSED = 3;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function normalizeMessage(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message;
  if (message && typeof message.toSegments === 'function') return message.toSegments();
  return [message];
}

function appendAccessToken(urlValue, accessToken) {
  if (!accessToken) return urlValue;
  const url = new URL(urlValue);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', accessToken);
  return url.toString();
}

function responseError(response) {
  const error = new Error(`OneBot action failed: status=${response?.status ?? '?'} retcode=${response?.retcode ?? '?'} ${response?.wording ?? response?.msg ?? ''}`.trim());
  error.name = 'OneBotApiError';
  error.response = response;
  return error;
}

function isMessageEvent(event) {
  return (event?.post_type === 'message' || event?.post_type === 'message_sent')
    && (event?.message_type === 'private' || event?.message_type === 'group');
}

function isNoticeEvent(event) {
  return event?.post_type === 'notice' && typeof event?.notice_type === 'string';
}

function isBotStatusEvent(event) {
  return isNoticeEvent(event)
    && event.notice_type === 'bot_status'
    && (event.sub_type === 'online' || event.sub_type === 'offline')
    && typeof event.user_id === 'number';
}

export function text(value) {
  return [{ type: 'text', data: { text: String(value ?? '') } }];
}

export class OneBotWebSocketClient {
  constructor(options = {}) {
    this.url = options.url ?? 'ws://127.0.0.1:3001/';
    this.accessToken = options.accessToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.protocols = options.protocols;
    this.WebSocketCtor = options.webSocket ?? options.WebSocketCtor ?? globalThis.WebSocket;
    this.reconnect = options.reconnect ?? true;
    this.listeners = new Map();
    this.pending = new Map();
    this.socket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.closedByUser = false;
    this.echoSeq = 0;
    if (!this.WebSocketCtor) throw new Error('No WebSocket implementation is available');
  }

  get isConnected() {
    return this.socket?.readyState === OPEN;
  }

  on(event, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  once(event, listener) {
    const off = this.on(event, (...args) => {
      off();
      listener(...args);
    });
    return off;
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, ...args) {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch (error) {
        if (event !== 'error') this.emit('error', error);
      }
    }
  }

  onEvent(listener) {
    return this.on('event', listener);
  }

  when(predicate, handler) {
    return this.on('event', (event) => {
      if (!predicate(event)) return;
      try {
        const result = handler(event);
        if (result && typeof result.catch === 'function') result.catch((error) => this.emit('error', error));
      } catch (error) {
        this.emit('error', error);
      }
    });
  }

  onPrivateMessage(handler) {
    return this.when((event) => isMessageEvent(event) && event.message_type === 'private', handler);
  }

  onGroupMessage(handler) {
    return this.when((event) => isMessageEvent(event) && event.message_type === 'group', handler);
  }

  onNotice(typeOrHandler, handler) {
    if (typeof typeOrHandler === 'string') {
      if (typeof handler !== 'function') throw new TypeError('onNotice(type, handler) requires a handler');
      return this.when((event) => isNoticeEvent(event) && event.notice_type === typeOrHandler, handler);
    }
    return this.when(isNoticeEvent, typeOrHandler);
  }

  onBotStatus(handler) {
    return this.when(isBotStatusEvent, handler);
  }

  onMetaEvent(handler) {
    return this.when((event) => event?.post_type === 'meta_event' && typeof event.meta_event_type === 'string', handler);
  }

  async connect() {
    if (this.isConnected) return;
    if (this.connectPromise) return this.connectPromise;
    this.closedByUser = false;
    const url = appendAccessToken(this.url, this.accessToken);
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new this.WebSocketCtor(url, this.protocols);
      this.socket = socket;
      let opened = false;

      const onOpen = () => {
        opened = true;
        this.reconnectAttempts = 0;
        this.connectPromise = null;
        this.emit('open');
        resolve();
      };

      const onMessage = (event) => {
        void this.handleMessage(event?.data);
      };

      const onError = (event) => {
        const error = event?.error ?? event;
        if (!opened) {
          this.connectPromise = null;
          reject(error instanceof Error ? error : new Error(String(error?.message ?? error ?? 'WebSocket error')));
        }
        this.emit('error', error);
      };

      const onClose = (event) => {
        if (this.socket === socket) this.socket = null;
        this.connectPromise = null;
        this.rejectPending(new Error('OneBot WebSocket closed'));
        if (!opened) {
          reject(new Error(`OneBot WebSocket closed before opening (code=${event?.code ?? '?'})`));
        }
        this.emit('close', { code: event?.code, reason: event?.reason });
        if (!this.closedByUser && this.socket === null) this.scheduleReconnect();
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
    return this.connectPromise;
  }

  close(code = 1000, reason = 'normal') {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPending(new Error('OneBot WebSocket client closed'));
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (socket && socket.readyState !== CLOSED) {
      try {
        socket.close(code, reason);
      } catch {}
    }
  }

  scheduleReconnect() {
    if (this.closedByUser || !this.reconnect || this.reconnectTimer) return;
    const retries = this.reconnect?.retries ?? Number.POSITIVE_INFINITY;
    if (this.reconnectAttempts >= retries) return;
    const minDelay = this.reconnect?.minDelayMs ?? RECONNECT_BASE_MS;
    const maxDelay = this.reconnect?.maxDelayMs ?? RECONNECT_MAX_MS;
    const delay = Math.min(maxDelay, minDelay * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.emit('error', error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch (error) {
      this.emit('error', error);
      return;
    }
    if (parsed && typeof parsed === 'object' && parsed.echo !== undefined) {
      const key = String(parsed.echo);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        pending.cleanup();
        pending.resolve(parsed);
        this.emit('response', parsed);
        return;
      }
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.post_type === 'string') {
      this.emit('event', parsed);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(action, params = {}, options = {}) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw new Error('OneBot WebSocket is not open');
    const echo = options.echo ?? `${Date.now()}-${this.echoSeq++}`;
    const key = String(echo);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const promise = new Promise((resolve, reject) => {
      let timer = null;
      let abortListener = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(key);
          cleanup();
          reject(new Error(`OneBot WebSocket request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      if (options.signal) {
        abortListener = () => {
          this.pending.delete(key);
          cleanup();
          reject(new Error('OneBot WebSocket request aborted'));
        };
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
      this.pending.set(key, { resolve, reject, cleanup });
    });
    try {
      socket.send(JSON.stringify({ action, params, echo }));
    } catch (error) {
      const pending = this.pending.get(key);
      pending?.cleanup();
      this.pending.delete(key);
      throw error;
    }
    return promise;
  }

  async call(action, params = {}, options = {}) {
    const response = await this.request(action, params, options);
    if (response?.status !== 'ok' || response?.retcode !== 0) throw responseError(response);
    return response.data;
  }

  raw(action, params = {}, options = {}) {
    return this.call(action, params, options);
  }

  sendMsg(params = {}, options = {}) {
    return this.call('send_msg', { ...params, message: normalizeMessage(params.message) }, options);
  }

  sendPrivateMessage(userId, message, options = {}) {
    return this.call('send_private_msg', {
      user_id: userId,
      message: normalizeMessage(message),
      auto_escape: options.autoEscape,
    }, options);
  }

  sendGroupMessage(groupId, message, options = {}) {
    return this.call('send_group_msg', {
      group_id: groupId,
      message: normalizeMessage(message),
      auto_escape: options.autoEscape,
    }, options);
  }

  getLoginInfo(options = {}) {
    return this.call('get_login_info', {}, options);
  }

  getStatus(options = {}) {
    return this.call('get_status', {}, options);
  }

  getMessage(messageId, options = {}) {
    return this.call('get_msg', { message_id: messageId }, options);
  }

  getImage(params, options = {}) {
    return this.call('get_image', params, options);
  }

  getGroupMemberList(groupId, options = {}) {
    return this.call('get_group_member_list', { group_id: groupId, no_cache: options.noCache }, options);
  }

  getGroupMemberInfo(groupId, userId, options = {}) {
    return this.call('get_group_member_info', {
      group_id: groupId,
      user_id: userId,
      no_cache: options.noCache,
    }, options);
  }

  fetchFaceEntity(faceId, options = {}) {
    return this.call('fetch_face_entity', {
      face_id: faceId,
      refresh: options.refresh ?? false,
    }, options);
  }
}
