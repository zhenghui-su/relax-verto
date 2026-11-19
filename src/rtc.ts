import { VertoBase } from './base';

/** 呼叫方向，用于决定是创建 offer 还是等待来电 offer。 */
export enum CallDirection {
  /** 收到远端 offer 的来电。 */
  Incoming,
  /** 由本地发起的去电。 */
  Outgoing,
}

/** VertoRtc 发出的 WebRTC 生命周期事件。 */
export interface VertoRtcEvents {
  /** ICE 收集完成后发送给 FreeSWITCH 的本地 offer。 */
  'send-offer': RTCSessionDescriptionInit;
  /** ICE 收集完成后发送给 FreeSWITCH 的本地 answer。 */
  'send-answer': RTCSessionDescriptionInit;
  /** 收到远端媒体轨道。 */
  track: MediaStreamTrack;
  /** WebRTC 协商失败或设置远端 SDP 失败。 */
  error: Error;
}

/** VertoRtc 的可选配置。 */
export interface VertoRtcOptions {
  /** 等待 ICE gathering 完成的最长时间，单位为毫秒。 */
  iceTimeout?: number;
  /** iceTimeout 的旧版拼写，供旧项目兼容。 */
  ice_timeout?: number;
  /** 自定义 RTCPeerConnection 工厂，适用于 Node、SSR 和测试环境。 */
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

type RtcState = 'idle' | 'gathering' | 'sent' | 'closed';

function defaultPeerConnectionFactory(configuration: RTCConfiguration): RTCPeerConnection {
  const PeerConnection = globalThis.RTCPeerConnection;
  if (!PeerConnection) {
    throw new Error(
      'RTCPeerConnection is unavailable. Run Verto in a WebRTC-capable browser or provide peerConnectionFactory.',
    );
  }
  return new PeerConnection(configuration);
}

/** 管理一个 RTCPeerConnection，并将 SDP 协商转换为 Verto 事件。 */
export class VertoRtc extends VertoBase<VertoRtcEvents> {
  private readonly peerConnection: RTCPeerConnection;
  private readonly direction: CallDirection;
  private readonly iceTimeout: number;
  private state: RtcState = 'idle';
  private pendingOfferSdp?: string;
  private negotiationInProgress = false;

  /**
   * 创建一个 WebRTC 会话。
   *
   * @param configuration RTCPeerConnection 配置，例如 iceServers。
   * @param direction 会话方向；去电会自动创建 offer，来电需要先调用 preSdp。
   * @param iceTimeout ICE 收集超时时间，单位为毫秒。
   * @param debug 是否输出 WebRTC 调试日志。
   * @param peerConnectionFactory 可选的 RTCPeerConnection 工厂。
   */
  public constructor(
    configuration: RTCConfiguration = {},
    direction = CallDirection.Incoming,
    iceTimeout = 3000,
    debug = false,
    peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection,
  ) {
    super(debug);
    this.direction = direction;
    this.iceTimeout = Math.max(0, iceTimeout);
    const factory = peerConnectionFactory ?? defaultPeerConnectionFactory;
    this.peerConnection = factory({
      ...configuration,
      iceCandidatePoolSize: configuration.iceCandidatePoolSize ?? 1,
    });
    this.peerConnection.ontrack = (event) => this.onTrack(event);
    this.peerConnection.onnegotiationneeded = () => {
      if (this.direction === CallDirection.Outgoing) void this.createOffer();
    };
    this.peerConnection.onicegatheringstatechange = () => undefined;
  }

  /** 获取底层 RTCPeerConnection，适合读取连接状态或调用 WebRTC 原生 API。 */
  public get connection(): RTCPeerConnection {
    return this.peerConnection;
  }

  private onTrack(event: RTCTrackEvent): void {
    this.dispatchEvent('track', event.track);
  }

  private async createOffer(): Promise<void> {
    if (this.negotiationInProgress || this.state === 'closed') return;
    this.negotiationInProgress = true;
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      await this.waitForIceGathering();
      this.dispatchLocalDescription('send-offer');
    } catch (error) {
      this.emitError(error);
    } finally {
      this.negotiationInProgress = false;
    }
  }

  private dispatchLocalDescription(event: 'send-offer' | 'send-answer'): void {
    const description = this.peerConnection.localDescription;
    if (!description || this.state === 'closed') return;
    if (this.state === 'sent' && event === 'send-offer') return;
    this.state = 'sent';
    this.dispatchEvent(event, { type: description.type, sdp: description.sdp ?? undefined });
  }

  private waitForIceGathering(): Promise<void> {
    if (this.peerConnection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = (): void => {
        if (
          this.peerConnection.iceGatheringState === 'complete' ||
          Date.now() - startedAt >= this.iceTimeout
        ) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.debug) console.error('[verto:rtc]', normalized);
    this.dispatchEvent('error', normalized);
  }

  /** 获取底层 WebRTC 统计信息。 */
  public getStats(): Promise<RTCStatsReport> {
    return this.peerConnection.getStats();
  }

  /**
   * 设置远端 answer SDP。
   *
   * @param sdp FreeSWITCH 返回的 answer SDP 文本。
   */
  public async onMedia(sdp: string): Promise<void> {
    try {
      await this.peerConnection.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      this.emitError(error);
      throw error;
    }
  }

  /**
   * 暂存来电的 offer SDP，供后续 answer 使用。
   *
   * @param sdp FreeSWITCH 推送的 offer SDP 文本。
   */
  public preSdp(sdp: string): void {
    this.pendingOfferSdp = sdp;
  }

  /**
   * 添加本地媒体轨道。
   *
   * @param track 由 getUserMedia 或其他 MediaStream 来源产生的轨道。
   * @returns WebRTC 创建的 RTCRtpSender。
   */
  public addTrack(track: MediaStreamTrack): RTCRtpSender {
    return this.peerConnection.addTrack(track);
  }

  /**
   * 为来电创建 answer，并在 ICE 收集完成后发出 send-answer 事件。
   *
   * @param tracks 接听时要发送给远端的本地媒体轨道。
   * @throws 尚未调用 preSdp，或 WebRTC 协商失败时抛出错误。
   */
  public async answer(tracks: readonly MediaStreamTrack[] = []): Promise<void> {
    if (!this.pendingOfferSdp) {
      throw new Error('Cannot answer before an incoming SDP offer is provided.');
    }
    try {
      for (const track of tracks) this.peerConnection.addTrack(track);
      await this.peerConnection.setRemoteDescription({ type: 'offer', sdp: this.pendingOfferSdp });
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.state = 'gathering';
      await this.waitForIceGathering();
      this.dispatchLocalDescription('send-answer');
    } catch (error) {
      this.emitError(error);
      throw error;
    }
  }

  /**
   * 关闭 PeerConnection 并移除全部事件监听器。
   *
   * 关闭后不能继续使用当前 VertoRtc 实例进行协商。
   */
  public close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.peerConnection.ontrack = null;
    this.peerConnection.onnegotiationneeded = null;
    this.peerConnection.onicegatheringstatechange = null;
    this.peerConnection.close();
    this.removeAllListeners();
  }
}
