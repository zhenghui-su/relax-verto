# @relaxwork/verto

一个符合 FreeSWITCH Verto JSON-RPC 规范的 TypeScript 客户端。它提供浏览器原生 WebSocket 和 WebRTC 的封装，但不绑定 React、Vue、Svelte 或任何 UI 框架，适合在组件、状态管理器和原生页面中复用。

当前包是纯 ESM，构建产物包含 JavaScript 和 TypeScript 声明文件。

## 安装

```bash
pnpm add @relaxwork/verto
```

## 环境要求

- 浏览器需要支持 WebSocket、RTCPeerConnection 和 MediaStreamTrack。
- 应用需要从 HTTPS 或 localhost 获取麦克风/摄像头权限。
- SSR、Node 测试和自定义 WebSocket 环境必须通过 transportConfig.socketFactory 注入 WebSocket。
- 非浏览器环境必须通过 peerConnectionFactory 注入 RTCPeerConnection。

库不会主动调用 getUserMedia。应用应先获取本地媒体轨道，再通过 call 的 tracks 参数或 VertoCall.addTrack 传入。

## 最小示例

```ts
import { Verto } from 'verto';

const localStream = await navigator.mediaDevices.getUserMedia({
	audio: true,
	video: true,
});

const verto = new Verto({
	transportConfig: {
		socketUrl: 'wss://pbx.example.com:8082',
		login: '1000@example.com',
		passwd: 'secret',
	},
	rtcConfig: {
		iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
	},
});

verto.on('error', (error) => console.error('Verto error', error));
verto.on('invite', (call) => {
	call.on('track', (track) => {
		const remoteAudio = document.querySelector('#remote-audio');
		if (remoteAudio instanceof HTMLAudioElement) {
			const stream =
				remoteAudio.srcObject instanceof MediaStream
					? remoteAudio.srcObject
					: new MediaStream();
			stream.addTrack(track);
			remoteAudio.srcObject = stream;
			void remoteAudio.play();
		}
	});

	// 业务确认接听后应调用 answer。
	void call.answer(localStream.getTracks());
});

await verto.login();

const call = verto.call(localStream.getTracks(), '1001', {
	caller_id_name: 'Web client',
	caller_id_number: '1000',
});

call.on('track', (track) => {
	// 将远端轨道绑定到 audio/video 元素。
	console.log('remote track', track.kind);
});

call.on('bye', () => {
	console.log('call ended');
});
```

## API

### Verto

Verto 是应用使用的顶层客户端。

- login(): Promise<Record<string, unknown>> 建立登录会话。
- call(tracks, destination, options?): VertoCall 发起呼叫。
- getCall(id): VertoCall | undefined 获取指定会话。
- activeCalls: readonly VertoCall[] 获取当前会话快照。
- isLogged(): boolean 判断是否已经登录。
- sessionId: string | undefined 获取 FreeSWITCH 返回的 sessid。
- logout(): void 结束会话并关闭 WebSocket。
- destroy(): void 释放会话和所有监听器。

Verto 事件：

- invite: 收到来电时触发，参数为 VertoCall。
- message: 收到任意 Verto JSON-RPC 通知时触发，参数为 { method, params }。
- error: 传输或会话发生错误时触发。

### VertoCall

- onAnswer(sdp?): Promise<void> 和 onMedia(sdp?): Promise<void> 处理远端 SDP。
- answer(tracks?): Promise<void> 接听来电并发送 verto.answer。
- hangup(params?): Promise<void> 挂断并发送 verto.bye。
- addTrack(track): RTCRtpSender 添加本地媒体轨道。
- getStats(): Promise<RTCStatsReport> 获取 WebRTC 统计信息。
- dtmf(input): Promise<unknown> 发送 DTMF。
- hold(params?), unhold(params?), toggleHold(params?) 处理保持/恢复。
- clear(): void 本地关闭会话。

VertoCall 事件：

- track: 收到远端 MediaStreamTrack。
- answer: 远端回答处理完成。
- media: 收到远端媒体协商消息。
- bye: 会话结束。
- hold / unhold: 保持状态变化。
- error: 会话或 WebRTC 错误。

### 事件订阅

所有主要对象都继承 VertoBase，提供以下方法：

```ts
const id = verto.on('error', handler);
verto.off('error', id);
// 也可以使用 subscribeEvent / unsubscribeEvent。
```

订阅返回稳定 ID，组件卸载时应调用 off 或 unsubscribeEvent，避免重复监听。

### JSON-RPC 传输

JsonRpcClient 是公开导出的底层 JSON-RPC 2.0 客户端，可用于需要直接调用 FreeSWITCH 方法的场景。

```ts
const result = await client.call('some.method', { key: 'value' });
```

客户端会在连接建立前排队请求，连接异常时自动指数退避重连，并在认证错误 -32000 时使用 transportConfig 中的 login/passwd 自动登录后重试原请求。设置 reconnect: false 可关闭自动重连。

Node 或 SSR 示例：

```ts
const verto = new Verto({
	transportConfig: {
		socketUrl: 'wss://pbx.example.com:8082',
		socketFactory: (url) => new MyWebSocket(url),
	},
	peerConnectionFactory: (config) => new MyPeerConnection(config),
});
```

## React、Vue、Svelte 接入建议

库本身不管理组件状态。建议在组件挂载时创建或接收 Verto 实例，保存订阅 ID，在卸载时移除监听：

```ts
const subscriptionId = call.on('track', setRemoteTrack);
// cleanup
call.off('track', subscriptionId);
```

远端音视频元素的渲染、通话按钮和状态管理由 UI 层决定；VertoCall 只提供协议状态和媒体轨道事件。

## FreeSWITCH 侧配置

请确保 FreeSWITCH 已启用 mod_verto，并在 WSS 端口、证书、用户认证和 ICE/STUN/TURN 配置上与前端环境匹配。Verto JSON-RPC 方法名和 dialogParams 由库按协议发送，业务侧只需提供目标号码、认证信息和媒体轨道。

## 示例

demo为 react 接入示例

## 本地开发

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run test
```

watch 模式：

```bash
pnpm run dev
pnpm run test:watch
```
