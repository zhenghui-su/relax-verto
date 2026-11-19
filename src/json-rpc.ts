import { VertoBase } from './base';

export interface JsonRpcClientParams {
  /** FreeSWITCH Verto WebSocket/WSS 地址。 */
  socketUrl: string;
  /** 兼容旧版客户端的 HTTP 地址，目前不会被 JsonRpcClient 主动使用。 */
  ajaxUrl?: string;
  /** 登录用户名；启用自动认证重试时必填。 */
  login?: string;
  /** 登录密码；启用自动认证重试时必填。 */
  passwd?: string;
  /** 已有会话 ID，通常由服务端登录结果返回。 */
  sessid?: string;
  /** 发送给 login 方法的额外参数。 */
  loginParams?: Record<string, unknown>;
  /** 登录时传给 FreeSWITCH 的用户变量。 */
  userVariables?: Record<string, unknown>;
  /** 收到原始 WebSocket 消息时调用，适合调试或记录原始报文。 */
  onmessage?: (event: MessageEvent<unknown>) => void;
  /** 自定义 WebSocket 工厂；SSR、Node 或测试环境必须提供。 */
  socketFactory?: WebSocketFactory;
  /** 是否在连接断开后自动重连，默认 true。 */
  reconnect?: boolean;
  /** 首次重连等待时间，后续重连采用指数退避，单位为毫秒。 */
  reconnectDelay?: number;
  /** 最大重连次数；不设置时表示不限制次数。 */
  maxReconnectAttempts?: number;
}

/** JsonRpcClient 所需的最小 WebSocket 接口，便于注入浏览器或 Node 实现。 */
export interface WebSocketLike {
  /** WebSocket readyState，0 表示连接中，1 表示已打开，3 表示已关闭。 */
  readonly readyState: number;
  /** 连接成功后触发。 */
  onopen: ((event: Event) => void) | null;
  /** 收到服务端消息后触发。 */
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  /** 底层连接发生错误时触发。 */
  onerror: ((event: Event) => void) | null;
  /** 连接关闭后触发。 */
  onclose: ((event: CloseEvent) => void) | null;
  /** 发送一条文本 WebSocket 消息。 */
  send(data: string): void;
  /** 关闭 WebSocket 连接。 */
  close(code?: number, reason?: string): void;
}

/** 创建 WebSocket 连接的工厂函数。 */
export type WebSocketFactory = (url: string) => WebSocketLike;
/** JSON-RPC 方法参数对象。 */
export type JsonRpcParams = Record<string, unknown>;

/** JSON-RPC 2.0 请求报文。 */
export interface JsonRpcRequest<TParams extends JsonRpcParams = JsonRpcParams> {
  /** 请求 ID，用于匹配响应。 */
  id: number;
  /** 固定为 JSON-RPC 版本 2.0。 */
  jsonrpc: '2.0';
  /** FreeSWITCH 或 Verto 方法名。 */
  method: string;
  /** 方法参数。 */
  params: TParams;
}

/** JSON-RPC 错误载荷。 */
export interface JsonRpcErrorPayload {
  /** 服务端错误码。 */
  code?: number;
  /** 服务端错误消息。 */
  message?: string;
  /** 服务端附加错误数据。 */
  data?: unknown;
}

/** JSON-RPC 调用失败时抛出的错误类型。 */
export class JsonRpcError extends Error {
  /** FreeSWITCH 返回的错误码。 */
  public readonly code?: number;
  /** FreeSWITCH 返回的附加错误数据。 */
  public readonly data?: unknown;

  /**
   * 创建 JSON-RPC 错误。
   *
   * @param payload 服务端返回的错误载荷。
   */
  public constructor(payload: JsonRpcErrorPayload) {
    super(payload.message ?? 'JSON-RPC request failed');
    this.name = 'JsonRpcError';
    this.code = payload.code;
    this.data = payload.data;
  }
}

interface JsonRpcResponse {
  id?: number;
  jsonrpc?: string;
  method?: string;
  params?: JsonRpcParams;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

interface PendingRequest<T = unknown> {
  request: JsonRpcRequest;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  success?: (data: T) => void;
  failure?: (error: JsonRpcError) => void;
  authRetryAllowed: boolean;
  authRetryInProgress: boolean;
}

const OPEN = 1;

function defaultSocketFactory(url: string): WebSocketLike {
  const Socket = globalThis.WebSocket;
  if (!Socket) {
    throw new Error(
      'WebSocket is unavailable. Provide transportConfig.socketFactory in SSR or Node.',
    );
  }
  return new Socket(url);
}

/** Verto 信令层使用的 JSON-RPC 2.0 客户端。 */
export class JsonRpcClient extends VertoBase {
  private readonly options: JsonRpcClientParams;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private readonly queuedRequestIds: number[] = [];
  private requestId = 1;
  private socket?: WebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private hasConnected = false;
  private closed = false;
  private eventHandler?: (method: string, params: JsonRpcParams) => void;
  private reconnectHandler?: () => void;
  private readonly connectionWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  /**
   * 创建 JSON-RPC 客户端。
   *
   * @param options WebSocket、认证和重连配置。
   * @param debug 是否输出发送报文和回调错误。
   */
  public constructor(options: JsonRpcClientParams, debug = false) {
    super(debug);
    this.options = { reconnect: true, reconnectDelay: 1000, ...options };
  }

  /**
   * 注册服务端通知处理器。
   *
   * 服务端推送的请求没有 result/error 响应，通常用于接收 verto.invite、
   * verto.answer、verto.media 和 verto.bye。
   *
   * @param handler 收到通知时调用，参数依次为方法名和参数对象。
   */
  public setEventHandler(handler: (method: string, params: JsonRpcParams) => void): void {
    this.eventHandler = handler;
  }

  /**
   * 注册 WebSocket 重连回调。
   *
   * @param handler 连接在首次打开后再次建立时调用。
   */
  public setReconnectHandler(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  /**
   * 主动打开 WebSocket 连接。
   *
   * 调用 call 时也会自动懒加载连接，因此大多数场景无需手动调用本方法。
   *
   * @returns WebSocket 完成 open 事件后的 Promise。
   */
  public connect(): Promise<void> {
    if (this.socket?.readyState === OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.connectionWaiters.push({ resolve, reject });
      try {
        this.ensureSocket();
      } catch (error) {
        this.connectionWaiters.splice(this.connectionWaiters.length - 1, 1);
        reject(error);
      }
    });
  }

  /**
   * 发送一个 JSON-RPC 2.0 请求。
   *
   * @typeParam TResult 服务端 result 的类型。
   * @param method 方法名，例如 login 或 verto.info。
   * @param params 方法参数对象，默认为空对象。
   * @param success 兼容回调风格的成功回调，可选。
   * @param failure 兼容回调风格的失败回调，可选。
   * @returns 解析为服务端 result 的 Promise。
   *
   * @example
   * const result = await client.call<{ ok: boolean }>('ping', {});
   */
  public call<TResult = unknown>(
    method: string,
    params: JsonRpcParams = {},
    success?: (data: TResult) => void,
    failure?: (error: JsonRpcError) => void,
  ): Promise<TResult> {
    return this.createCall(method, params, success, failure, true);
  }

  private createCall<TResult>(
    method: string,
    params: JsonRpcParams,
    success: ((data: TResult) => void) | undefined,
    failure: ((error: JsonRpcError) => void) | undefined,
    authRetryAllowed: boolean,
  ): Promise<TResult> {
    const request: JsonRpcRequest = { jsonrpc: '2.0', method, params, id: this.requestId++ };
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(request.id, {
        request,
        resolve: resolve as (value: unknown) => void,
        reject,
        success: success as ((data: unknown) => void) | undefined,
        failure,
        authRetryAllowed,
        authRetryInProgress: false,
      });
      this.queuedRequestIds.push(request.id);
      try {
        this.ensureSocket();
        this.flushQueue();
      } catch (error) {
        this.rejectRequest(request.id, error);
      }
    });
  }

  private ensureSocket(): void {
    if (this.closed) throw new Error('JSON-RPC client is closed');
    if (this.socket && this.socket.readyState !== 3) return;
    const factory = this.options.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.options.socketUrl);
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = () => undefined;
    socket.onclose = () => this.handleClose();
  }

  private handleOpen(): void {
    const wasReconnect = this.hasConnected;
    this.hasConnected = true;
    this.reconnectAttempts = 0;
    if (wasReconnect) this.reconnectHandler?.();
    for (const waiter of this.connectionWaiters.splice(0)) waiter.resolve();
    this.flushQueue();
  }

  private flushQueue(): void {
    if (this.socket?.readyState !== OPEN) return;
    const requestIds = this.queuedRequestIds.splice(0);
    for (const id of requestIds) this.sendRequest(id);
  }

  private sendRequest(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (this.socket?.readyState !== OPEN) {
      this.queuedRequestIds.push(id);
      return;
    }
    try {
      const raw = JSON.stringify(pending.request);
      this.socket.send(raw);
      if (this.debug) console.debug('[verto:send]', pending.request);
    } catch (error) {
      this.rejectRequest(id, error);
    }
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    this.options.onmessage?.(event);
    if (typeof event.data !== 'string') return;
    let response: JsonRpcResponse;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!parsed || typeof parsed !== 'object') return;
      response = parsed as JsonRpcResponse;
    } catch {
      return;
    }
    if (response.jsonrpc !== '2.0') return;
    if (response.method) {
      this.eventHandler?.(response.method, response.params ?? {});
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if ('result' in response) {
      this.resolveRequest(response.id, response.result);
      return;
    }
    if (!response.error) return;
    const error = new JsonRpcError(response.error);
    if (
      error.code === -32000 &&
      pending.authRetryAllowed &&
      !pending.authRetryInProgress &&
      this.options.login &&
      this.options.passwd
    ) {
      pending.authRetryInProgress = true;
      void this.authenticateAndRetry(response.id);
      return;
    }
    this.rejectRequest(response.id, error);
  }

  private async authenticateAndRetry(id: number): Promise<void> {
    try {
      await this.createCall(
        'login',
        {
          login: this.options.login,
          passwd: this.options.passwd,
          loginParams: this.options.loginParams,
          userVariables: this.options.userVariables,
        },
        undefined,
        undefined,
        false,
      );
      const pending = this.pending.get(id);
      if (pending) {
        pending.authRetryInProgress = false;
        this.sendRequest(id);
      }
    } catch (error) {
      this.rejectRequest(id, error);
    }
  }

  private resolveRequest(id: number, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.invoke(() => pending.success?.(value));
    pending.resolve(value);
  }

  private rejectRequest(id: number, reason: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error =
      reason instanceof JsonRpcError
        ? reason
        : new JsonRpcError({ message: reason instanceof Error ? reason.message : String(reason) });
    this.invoke(() => pending.failure?.(error));
    pending.reject(error);
  }

  private invoke(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      if (this.debug) console.error('[verto:callback]', error);
    }
  }

  private handleClose(): void {
    this.socket = undefined;
    if (this.closed || this.options.reconnect === false) return;
    const queued = new Set(this.queuedRequestIds);
    for (const id of this.pending.keys()) {
      if (!queued.has(id)) this.queuedRequestIds.push(id);
    }
    const maxAttempts = this.options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    if (this.reconnectAttempts >= maxAttempts) {
      for (const id of this.pending.keys()) {
        this.rejectRequest(id, new Error('WebSocket reconnect attempts exhausted'));
      }
      return;
    }
    this.reconnectAttempts += 1;
    const baseDelay = this.options.reconnectDelay ?? 1000;
    const delay = Math.min(baseDelay * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      try {
        this.ensureSocket();
        this.flushQueue();
      } catch (error) {
        if (this.debug) console.error('[verto:reconnect]', error);
        this.handleClose();
      }
    }, delay);
  }

  /**
   * 关闭连接、取消自动重连并拒绝尚未完成的请求。
   *
   * 该方法不可逆；若要重新连接，请创建新的 JsonRpcClient 实例。
   */
  public close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const id of this.pending.keys()) {
      this.rejectRequest(id, new Error('JSON-RPC client closed'));
    }
    this.queuedRequestIds.splice(0);
    this.socket?.close(1000, 'Client closed');
    this.socket = undefined;
    this.eventHandler = undefined;
    this.reconnectHandler = undefined;
    for (const waiter of this.connectionWaiters.splice(0)) {
      waiter.reject(new Error('JSON-RPC client closed'));
    }
  }
}
