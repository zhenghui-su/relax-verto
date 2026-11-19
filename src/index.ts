import { generateGUID, VertoBase } from './base';
import {
  JsonRpcClient,
  type JsonRpcClientParams,
  type JsonRpcParams,
} from './json-rpc';
import { CallDirection, VertoRtc } from './rtc';

export { generateGUID, VertoBase } from './base';
export {
  JsonRpcClient,
  JsonRpcError,
  type JsonRpcClientParams,
  type JsonRpcParams,
  type JsonRpcRequest,
  type WebSocketFactory,
  type WebSocketLike,
} from './json-rpc';
export { CallDirection, VertoRtc, type VertoRtcEvents, type VertoRtcOptions } from './rtc';

/** FreeSWITCH Verto JSON-RPC 方法名常量。 */
export const VertoMessage = {
  Invite: 'verto.invite',
  Answer: 'verto.answer',
  Bye: 'verto.bye',
  Media: 'verto.media',
  Attach: 'verto.attach',
  Modify: 'verto.modify',
  Subscribe: 'verto.subscribe',
  Unsubscribe: 'verto.unsubscribe',
  Info: 'verto.info',
  Display: 'verto.display',
  ClientReady: 'verto.clientReady',
  Broadcast: 'verto.broadcast',
} as const;

export interface VertoCallOptions extends Record<string, unknown> {
  /** 发起方号码，通常显示在对端来电信息中。 */
  caller_id_number?: string;
  /** 发起方显示名称。 */
  caller_id_name?: string;
  /** 被叫号码的显示值；实际呼叫目标由 call 的 destination 参数决定。 */
  callee_id_number?: string;
  /** 被叫方显示名称。 */
  callee_id_name?: string;
}

/** 创建 Verto 客户端时使用的配置。 */
export interface VertoOptions {
  /** Verto WebSocket 地址、认证信息和 JSON-RPC 传输选项。 */
  transportConfig: JsonRpcClientParams;
  /** RTCPeerConnection 配置，例如 FreeSWITCH 部署所需的 STUN/TURN servers。 */
  rtcConfig?: RTCConfiguration;
  /** 是否输出调试日志，默认 false。 */
  debug?: boolean;
  /** 等待 ICE 收集完成的时间，单位为毫秒，默认 3000。 */
  iceTimeout?: number;
  /** iceTimeout 的旧版拼写，供旧项目兼容。 */
  ice_timeout?: number;
  /** 自定义 PeerConnection 工厂，适用于 SSR、Node 或测试环境。 */
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

/** VertoCall 可订阅的事件及其回调参数。 */
export interface VertoCallEvents {
  /** 收到远端音频或视频轨道。 */
  track: MediaStreamTrack;
  /** 收到并应用远端 answer 后触发，无事件数据。 */
  answer: undefined;
  /** 收到并应用远端媒体 SDP 后触发，无事件数据。 */
  media: undefined;
  /** 会话被本地或远端清理时触发，参数为当前会话。 */
  bye: VertoCall;
  /** FreeSWITCH 确认呼叫进入 held 状态时触发。 */
  hold: VertoCall;
  /** FreeSWITCH 确认呼叫离开 held 状态时触发。 */
  unhold: VertoCall;
  /** 会话信令或 WebRTC 操作失败时触发。 */
  error: Error;
}

/** Verto 客户端可订阅的事件及其回调参数。 */
export interface VertoEvents {
  /** 收到来电邀请时触发，参数为可接听的 VertoCall。 */
  invite: VertoCall;
  /** 收到任意服务端 Verto 通知时触发。 */
  message: { method: string; params: JsonRpcParams };
  /** 客户端发生错误时触发。 */
  error: Error;
}

/** FreeSWITCH 保持状态修改响应。 */
export interface HoldResponse {
  /** 当前保持状态，held 表示已保持。 */
  holdState?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 表示一个 Verto dialog 及其关联的 WebRTC 媒体会话。 */
export class VertoCall extends VertoBase<VertoCallEvents> {
  private readonly rtc: VertoRtc;
  private readonly rpc: JsonRpcClient;
  private cleared = false;

  /** FreeSWITCH 为该 dialog 分配或客户端生成的唯一 ID。 */
  public readonly id: string;
  /** 创建呼叫时附加的 caller/callee 信息。 */
  public readonly options: VertoCallOptions;
  /** 当前会话是来电还是去电。 */
  public readonly direction: CallDirection;
  /** 最近一次 hold 操作确认后的保持状态。 */
  public holdStatus = false;

  /**
   * 创建 VertoCall。通常由 Verto.call() 或收到 invite 事件时创建。
   *
   * @param configuration RTCPeerConnection 配置。
   * @param rpc 与 FreeSWITCH 通信的 JSON-RPC 客户端。
   * @param destination 去电目标号码；省略时按来电处理。
   * @param id dialog ID；省略时自动生成 UUID。
   * @param options 呼叫显示信息及需要附加到 dialogParams 的字段。
   * @param iceTimeout ICE gathering 等待时间，单位为毫秒。
   * @param debug 是否输出调试日志。
   * @param peerConnectionFactory 可选的 RTCPeerConnection 工厂。
   */
  public constructor(
    configuration: RTCConfiguration = {},
    rpc: JsonRpcClient,
    destination?: string,
    id = generateGUID(),
    options: VertoCallOptions = {},
    iceTimeout = 3000,
    debug = false,
    peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection,
  ) {
    super(debug);
    this.id = id;
    this.options = options;
    this.direction = destination ? CallDirection.Outgoing : CallDirection.Incoming;
    this.rpc = rpc;
    this.rtc = new VertoRtc(
      configuration,
      this.direction,
      iceTimeout,
      debug,
      peerConnectionFactory,
    );

    this.rtc.on('send-offer', (description) => {
      void this.sendSdp(VertoMessage.Invite, description.sdp, destination);
    });
    this.rtc.on('send-answer', (description) => {
      void this.sendSdp(VertoMessage.Answer, description.sdp, destination);
    });
    this.rtc.on('track', (track) => this.dispatchEvent('track', track));
    this.rtc.on('error', (error) => this.dispatchEvent('error', error));
  }

  private async sendSdp(
    method: string,
    sdp: string | undefined,
    destination?: string,
  ): Promise<void> {
    try {
      await this.rpc.call(method, {
        dialogParams: {
          ...this.options,
          destination_number: destination,
          callID: this.id,
        },
        sdp,
      });
    } catch (error) {
      this.dispatchEvent('error', normalizeError(error));
    }
  }

  /**
   * 获取当前 PeerConnection 的统计信息。
   *
   * @returns 浏览器提供的 WebRTC 统计报告。
   */
  public getStats(): Promise<RTCStatsReport> {
    return this.rtc.getStats();
  }

  /**
   * 接收并应用 FreeSWITCH 返回的 answer SDP。
   *
   * @param sdp 远端 answer SDP；不传时只派发 answer 事件。
   */
  public async onAnswer(sdp?: string): Promise<void> {
    if (sdp) await this.rtc.onMedia(sdp);
    this.dispatchEvent('answer', undefined);
  }

  /**
   * 接收并应用新的远端媒体 SDP。
   *
   * @param sdp 远端 answer SDP。
   */
  public async onMedia(sdp?: string): Promise<void> {
    if (sdp) await this.rtc.onMedia(sdp);
    this.dispatchEvent('media', undefined);
  }

  /**
   * 向当前会话添加一条本地媒体轨道。
   *
   * @param track 由 getUserMedia 等方式获取的音频或视频轨道。
   * @returns 对应的 RTCRtpSender。
   */
  public addTrack(track: MediaStreamTrack): RTCRtpSender {
    return this.rtc.addTrack(track);
  }

  /**
   * 暂存来电 offer；Verto 客户端收到 verto.invite 时会自动调用。
   *
   * @param sdp FreeSWITCH 推送的 offer SDP。
   */
  public preSdp(sdp: string): void {
    this.rtc.preSdp(sdp);
  }

  /**
   * 接听来电并发送 Verto answer。
   *
   * @param tracks 接听时发送到对端的本地媒体轨道，可传空数组接听纯音频/无本地媒体会话。
   * @returns SDP 协商及发送流程完成后的 Promise。
   */
  public answer(tracks: readonly MediaStreamTrack[] = []): Promise<void> {
    return this.rtc.answer(tracks);
  }

  /**
   * 向 FreeSWITCH 发送挂断请求并清理本地 PeerConnection。
   *
   * @param params 附加到 verto.bye 请求的顶层参数。
   */
  public async hangup(params: JsonRpcParams = {}): Promise<void> {
    try {
      await this.rpc.call(VertoMessage.Bye, {
        dialogParams: { callID: this.id },
        ...params,
      });
    } finally {
      this.clear();
    }
  }

  /** 仅在本地清理会话，不向 FreeSWITCH 发送 verto.bye。 */
  public clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    this.rtc.close();
    this.dispatchEvent('bye', this);
  }

  /**
   * 发送 DTMF 按键。
   *
   * @param input 要发送的按键，例如 0-9、* 或 #。
   * @returns FreeSWITCH 的 JSON-RPC 响应。
   */
  public dtmf(input: string | number): Promise<unknown> {
    return this.rpc.call(VertoMessage.Info, {
      dtmf: String(input),
      dialogParams: { callID: this.id },
    });
  }

  /**
   * 请求将当前呼叫置为保持状态。
   *
   * @param params 附加到 dialogParams 的 FreeSWITCH 专属参数。
   */
  public hold(params: JsonRpcParams = {}): Promise<HoldResponse> {
    return this.modifyHold('hold', params);
  }

  /**
   * 请求恢复当前已保持的呼叫。
   *
   * @param params 附加到 dialogParams 的 FreeSWITCH 专属参数。
   */
  public unhold(params: JsonRpcParams = {}): Promise<HoldResponse> {
    return this.modifyHold('unhold', params);
  }

  /**
   * 请求切换当前呼叫的保持状态。
   *
   * @param params 附加到 dialogParams 的 FreeSWITCH 专属参数。
   */
  public toggleHold(params: JsonRpcParams = {}): Promise<HoldResponse> {
    return this.modifyHold('toggleHold', params);
  }

  private async modifyHold(
    action: 'hold' | 'unhold' | 'toggleHold',
    params: JsonRpcParams,
  ): Promise<HoldResponse> {
    try {
      const response = await this.rpc.call<HoldResponse>(VertoMessage.Modify, {
        action,
        dialogParams: { callID: this.id, ...this.options, ...params },
      });
      this.holdStatus = response.holdState === 'held';
      this.dispatchEvent(this.holdStatus ? 'hold' : 'unhold', this);
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      this.dispatchEvent('error', normalized);
      throw normalized;
    }
  }
}

/** 与 UI 框架无关的 FreeSWITCH Verto 客户端。 */
export class Verto extends VertoBase<VertoEvents> {
  private readonly calls = new Map<string, VertoCall>();
  private readonly rpc: JsonRpcClient;
  private readonly options: VertoOptions & { rtcConfig: RTCConfiguration };
  private loggedIn = false;
  private currentSessionId?: string;

  /**
   * 创建 Verto 客户端。
   *
   * 构造时不会立即打开 WebSocket；首次 login 或 JSON-RPC 请求时才连接。
   *
   * @param options WebSocket 登录、WebRTC 和调试配置。
   */
  public constructor(options: VertoOptions) {
    super(options.debug ?? false);
    this.options = {
      ...options,
      rtcConfig: { ...options.rtcConfig },
      iceTimeout: options.iceTimeout ?? options.ice_timeout ?? 3000,
    };
    this.rpc = new JsonRpcClient(options.transportConfig, options.debug ?? false);
    this.rpc.setEventHandler((method, params) => this.handleMessage(method, params));
    this.rpc.setReconnectHandler(() => {
      if (this.loggedIn) void this.login();
    });
  }

  private handleMessage(method: string, params: JsonRpcParams): void {
    this.dispatchEvent('message', { method, params });
    const callId = asString(params.callID);
    if (!callId && method !== VertoMessage.Invite) return;

    switch (method) {
      case VertoMessage.Answer: {
        const call = callId ? this.calls.get(callId) : undefined;
        if (call) void call.onAnswer(asString(params.sdp)).catch((error) => call.dispatchEvent('error', normalizeError(error)));
        break;
      }
      case VertoMessage.Media: {
        const call = callId ? this.calls.get(callId) : undefined;
        if (call) void call.onMedia(asString(params.sdp)).catch((error) => call.dispatchEvent('error', normalizeError(error)));
        break;
      }
      case VertoMessage.Invite: {
        const inviteId = asString(params.callID);
        const sdp = asString(params.sdp);
        if (!inviteId || !sdp) return;
        const call = new VertoCall(
          this.options.rtcConfig,
          this.rpc,
          undefined,
          inviteId,
          {
            caller_id_name: asString(params.caller_id_name),
            caller_id_number: asString(params.caller_id_number),
          },
          this.options.iceTimeout,
          this.options.debug,
          this.options.peerConnectionFactory,
        );
        call.preSdp(sdp);
        this.registerCall(call);
        this.dispatchEvent('invite', call);
        break;
      }
      case VertoMessage.Bye: {
        const call = callId ? this.calls.get(callId) : undefined;
        call?.clear();
        if (callId) this.calls.delete(callId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * 登录 FreeSWITCH Verto 会话。
   *
   * @returns 服务端登录响应；成功后 isLogged() 返回 true。
   * @throws 连接或认证失败时 Promise reject。
   */
  public login(): Promise<Record<string, unknown>> {
    return this.rpc
      .call<Record<string, unknown>>('login', {
        login: this.options.transportConfig.login,
        passwd: this.options.transportConfig.passwd,
        loginParams: this.options.transportConfig.loginParams,
        userVariables: this.options.transportConfig.userVariables,
      })
      .then((data) => {
        this.currentSessionId = asString(data.sessid);
        this.loggedIn = true;
        return data;
      });
  }

  /**
   * 创建并登记一个去电会话。
   *
   * @param tracks 本次呼叫发送的本地媒体轨道，通常来自 getUserMedia。
   * @param destination FreeSWITCH 可路由的目标号码或用户标识。
   * @param options caller/callee 显示信息及附加 dialogParams。
   * @returns 新建的会话；通过 track、bye、error 等事件监听状态变化。
   *
   * @example
   * const call = verto.call(stream.getTracks(), '1001');
   * call.on('track', (track) => attachRemoteTrack(track));
   */
  public call(
    tracks: readonly MediaStreamTrack[],
    destination: string,
    options: VertoCallOptions = {},
  ): VertoCall {
    const call = new VertoCall(
      this.options.rtcConfig,
      this.rpc,
      destination,
      generateGUID(),
      options,
      this.options.iceTimeout,
      this.options.debug,
      this.options.peerConnectionFactory,
    );
    for (const track of tracks) call.addTrack(track);
    this.registerCall(call);
    return call;
  }

  private registerCall(call: VertoCall): void {
    this.calls.set(call.id, call);
    call.on('bye', () => {
      if (this.calls.get(call.id) === call) this.calls.delete(call.id);
    });
  }

  /**
   * 获取指定 dialog 的会话对象。
   *
   * @param id VertoCall.id。
   * @returns 活动会话；不存在或已结束时返回 undefined。
   */
  public getCall(id: string): VertoCall | undefined {
    return this.calls.get(id);
  }

  /** 返回活动会话数组的只读快照。 */
  public get activeCalls(): readonly VertoCall[] {
    return [...this.calls.values()];
  }

  /** 当前客户端是否已成功登录。 */
  public isLogged(): boolean {
    return this.loggedIn;
  }

  /** 最近一次登录响应中的 sessid；服务端未返回时为 undefined。 */
  public get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * 挂断所有活动会话并关闭 WebSocket。
   *
   * 关闭后的客户端不可再次登录；需要重新连接时请创建新的 Verto 实例。
   */
  public logout(): void {
    for (const call of this.calls.values()) {
      void call.hangup().catch(() => undefined);
    }
    this.calls.clear();
    this.rpc.close();
    this.currentSessionId = undefined;
    this.loggedIn = false;
  }

  /** 释放客户端拥有的会话、传输和事件监听器。 */
  public destroy(): void {
    this.logout();
    this.removeAllListeners();
  }
}
