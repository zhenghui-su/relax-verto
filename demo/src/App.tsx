import { useEffect, useRef, useState } from 'react';
import { Verto, type VertoCall } from '@relaxwork/verto';
import { encodeWav } from './wav';
import './App.css';

const STORAGE_KEY = 'verto-react-demo-config';

type ConnectionState = 'idle' | 'signingIn' | 'signedIn';
type CallState = 'idle' | 'calling' | 'ringing' | 'active';
type CallEvent = 'track' | 'answer' | 'bye' | 'error';
type RecordingState = 'empty' | 'recording' | 'saving' | 'ready' | 'error';
type CallSubscription = { event: CallEvent; id: string };

interface DemoConfig {
	socketUrl: string;
	loginDomain: string;
	stunUrl: string;
	username: string;
	password: string;
	destination: string;
}

interface SavedRecording {
	url: string;
	filename: string;
	durationSeconds: number;
}

const DEFAULT_CONFIG: DemoConfig = {
	socketUrl: 'wss://xxxx:8082',
	loginDomain: 'default',
	stunUrl: 'stun:xxxx:3478',
	username: '1000',
	password: '1234',
	destination: '1000',
};

function loadConfig(): DemoConfig {
	if (typeof window === 'undefined') return DEFAULT_CONFIG;
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : DEFAULT_CONFIG;
	} catch {
		return DEFAULT_CONFIG;
	}
}

function App() {
	// 连接、通话和媒体对象属于外部资源，用 ref 保存，避免 React 重渲染重建它们。
	const vertoRef = useRef<Verto | null>(null);
	const callRef = useRef<VertoCall | null>(null);
	const localStreamRef = useRef<MediaStream | null>(null);
	const remoteStreamRef = useRef<MediaStream | null>(null);
	const remoteAudioRef = useRef<HTMLAudioElement>(null);
	const subscriptionsRef = useRef<CallSubscription[]>([]);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const recorderChunksRef = useRef<Blob[]>([]);
	const audioContextRef = useRef<AudioContext | null>(null);
	const recordingDestinationRef =
		useRef<MediaStreamAudioDestinationNode | null>(null);
	const recordingSourcesRef = useRef<MediaStreamAudioSourceNode[]>([]);
	const recordingStreamIdsRef = useRef<Set<string>>(new Set());
	const recordingStartedAtRef = useRef<number | null>(null);
	const savedRecordingUrlRef = useRef<string | null>(null);
	const recordingGenerationRef = useRef(0);

	const [config, setConfig] = useState<DemoConfig>(loadConfig);
	const [connectionState, setConnectionState] =
		useState<ConnectionState>('idle');
	const [connectionText, setConnectionText] = useState('未签入');
	const [callState, setCallState] = useState<CallState>('idle');
	const [callText, setCallText] = useState('暂无活动通话');
	const [incomingNumber, setIncomingNumber] = useState('—');
	const [logs, setLogs] = useState<string[]>([]);
	const [errorMessage, setErrorMessage] = useState('');
	const [recordingState, setRecordingState] = useState<RecordingState>('empty');
	const [recordingElapsed, setRecordingElapsed] = useState(0);
	const [savedRecording, setSavedRecording] = useState<SavedRecording | null>(
		null,
	);

	// 配置输入变化后立即保存，刷新页面仍然可以继续使用上次的测试参数。
	function updateConfig<Key extends keyof DemoConfig>(
		key: Key,
		value: DemoConfig[Key],
	) {
		setConfig((current) => {
			const next = { ...current, [key]: value };
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// 无痕浏览或浏览器禁用存储时，输入仍可用于当前页面会话。
			}
			return next;
		});
	}

	// 卸载页面时关闭 WebSocket、PeerConnection、录音器并释放 Blob URL。
	useEffect(
		() => () => {
			if (recorderRef.current?.state === 'recording')
				recorderRef.current.stop();
			callRef.current?.clear();
			vertoRef.current?.destroy();
			localStreamRef.current?.getTracks().forEach((track) => track.stop());
			void audioContextRef.current?.close();
			if (savedRecordingUrlRef.current)
				URL.revokeObjectURL(savedRecordingUrlRef.current);
		},
		[],
	);

	useEffect(() => {
		if (recordingState !== 'recording') return;
		const timer = window.setInterval(() => {
			if (recordingStartedAtRef.current !== null) {
				setRecordingElapsed(
					Math.floor((Date.now() - recordingStartedAtRef.current) / 1000),
				);
			}
		}, 500);
		return () => window.clearInterval(timer);
	}, [recordingState]);

	function log(message: string) {
		const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
		setLogs((current) => [time + '  ' + message, ...current].slice(0, 80));
	}

	function connectRecordingStream(stream: MediaStream) {
		const context = audioContextRef.current;
		const destination = recordingDestinationRef.current;
		if (
			!context ||
			!destination ||
			recordingStreamIdsRef.current.has(stream.id)
		)
			return;
		const source = context.createMediaStreamSource(stream);
		source.connect(destination);
		recordingSourcesRef.current.push(source);
		recordingStreamIdsRef.current.add(stream.id);
	}

	function disconnectRecordingSources() {
		recordingSourcesRef.current.forEach((source) => source.disconnect());
		recordingSourcesRef.current = [];
		recordingStreamIdsRef.current.clear();
		recordingDestinationRef.current = null;
	}

	async function startRecording() {
		const generation = ++recordingGenerationRef.current;
		if (savedRecordingUrlRef.current)
			URL.revokeObjectURL(savedRecordingUrlRef.current);
		savedRecordingUrlRef.current = null;
		setSavedRecording(null);
		setRecordingElapsed(0);

		if (!('MediaRecorder' in window)) {
			setRecordingState('error');
			setErrorMessage('当前浏览器不支持 MediaRecorder，无法录音。');
			return;
		}
		if (!localStreamRef.current) return;

		try {
			// MediaRecorder 先生成浏览器支持的临时音频，再在停止时转成通用 WAV。
			const context = audioContextRef.current ?? new AudioContext();
			audioContextRef.current = context;
			await context.resume();
			if (generation !== recordingGenerationRef.current) return;

			const destination = context.createMediaStreamDestination();
			recordingDestinationRef.current = destination;
			connectRecordingStream(localStreamRef.current);
			if (remoteStreamRef.current)
				connectRecordingStream(remoteStreamRef.current);

			const mimeType = [
				'audio/webm;codecs=opus',
				'audio/webm',
				'audio/ogg;codecs=opus',
			].find((type) => MediaRecorder.isTypeSupported(type));
			const recorder = mimeType
				? new MediaRecorder(destination.stream, { mimeType })
				: new MediaRecorder(destination.stream);
			const startedAt = Date.now();
			recorderChunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) recorderChunksRef.current.push(event.data);
			};
			recorder.onstop = async () => {
				try {
					const sourceBlob = new Blob(recorderChunksRef.current, {
						type: recorder.mimeType || 'audio/webm',
					});
					recorderChunksRef.current = [];
					disconnectRecordingSources();
					if (sourceBlob.size === 0 || !audioContextRef.current)
						throw new Error('录音为空');
					const sourceBuffer = await sourceBlob.arrayBuffer();
					const decoded =
						await audioContextRef.current.decodeAudioData(sourceBuffer);
					const wavBlob = encodeWav(decoded);
					const url = URL.createObjectURL(wavBlob);
					const filename =
						'verto-call-' +
						new Date().toISOString().replace(/[:.]/g, '-') +
						'.wav';
					savedRecordingUrlRef.current = url;
					setSavedRecording({
						url,
						filename,
						durationSeconds: Math.floor((Date.now() - startedAt) / 1000),
					});
					setRecordingState('ready');
					log('WAV 录音已生成，可下载保存');
				} catch (error) {
					disconnectRecordingSources();
					setRecordingState('error');
					setErrorMessage(
						'录音转 WAV 失败：' +
							(error instanceof Error ? error.message : String(error)),
					);
					log('录音转 WAV 失败');
				}
			};
			recorder.onerror = () => {
				disconnectRecordingSources();
				setRecordingState('error');
				setErrorMessage('录音过程中发生错误。');
				log('录音失败');
			};
			recorder.start(250);
			recorderRef.current = recorder;
			recordingStartedAtRef.current = startedAt;
			setRecordingState('recording');
			log('已开始录音');
		} catch (error) {
			disconnectRecordingSources();
			setRecordingState('error');
			setErrorMessage(
				'无法开始录音：' +
					(error instanceof Error ? error.message : String(error)),
			);
		}
	}

	function stopRecording() {
		recordingGenerationRef.current += 1;
		const recorder = recorderRef.current;
		if (!recorder || recorder.state !== 'recording') return;
		if (recordingStartedAtRef.current !== null) {
			setRecordingElapsed(
				Math.floor((Date.now() - recordingStartedAtRef.current) / 1000),
			);
		}
		setRecordingState('saving');
		recorder.requestData();
		recorder.stop();
		recorderRef.current = null;
		recordingStartedAtRef.current = null;
	}

	function attachRemoteTrack(track: MediaStreamTrack) {
		const stream = remoteStreamRef.current ?? new MediaStream();
		remoteStreamRef.current = stream;
		stream.addTrack(track);
		// 来电接通前远端流可能还不存在，录音已经开始时需要动态接入它。
		connectRecordingStream(stream);
		if (remoteAudioRef.current) {
			remoteAudioRef.current.srcObject = stream;
			void remoteAudioRef.current.play().catch(() => undefined);
		}
		log('收到远端 ' + track.kind + ' 轨道');
	}

	function clearRemoteMedia() {
		remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
		remoteStreamRef.current = null;
		if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
	}

	function removeCallListeners(call: VertoCall) {
		subscriptionsRef.current.forEach((subscription) =>
			call.off(subscription.event, subscription.id),
		);
		subscriptionsRef.current = [];
	}

	function finishCall(call: VertoCall) {
		stopRecording();
		removeCallListeners(call);
		if (callRef.current === call) callRef.current = null;
		setCallState('idle');
		setCallText('暂无活动通话');
		setIncomingNumber('—');
		clearRemoteMedia();
		log('通话已结束');
	}

	function watchCall(call: VertoCall, initialState: CallState, peer: string) {
		callRef.current = call;
		setCallState(initialState);
		setCallText(peer);
		subscriptionsRef.current = [
			{ event: 'track', id: call.on('track', attachRemoteTrack) },
			{
				event: 'answer',
				id: call.on('answer', () => {
					setCallState('active');
					log('对方已接听');
				}),
			},
			{ event: 'bye', id: call.on('bye', () => finishCall(call)) },
			{
				event: 'error',
				id: call.on('error', (error) => {
					setErrorMessage(error.message);
					log('通话错误：' + error.message);
				}),
			},
		];
	}

	async function signIn() {
		setErrorMessage('');
		setConnectionState('signingIn');
		setConnectionText('签入中…');
		try {
			localStreamRef.current = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
			const client = new Verto({
				transportConfig: {
					socketUrl: config.socketUrl,
					login: config.username + '@' + config.loginDomain,
					passwd: config.password,
				},
				rtcConfig: config.stunUrl
					? { iceServers: [{ urls: config.stunUrl }] }
					: {},
				debug: true,
			});
			vertoRef.current = client;
			client.on('error', (error) => {
				setErrorMessage(error.message);
				log('客户端错误：' + error.message);
			});
			client.on('invite', (call) => {
				if (callRef.current) {
					void call.hangup().catch(() => call.clear());
					return;
				}
				const caller =
					call.options.caller_id_number ||
					call.options.caller_id_name ||
					'未知';
				setIncomingNumber(caller);
				watchCall(call, 'ringing', caller);
				log('收到来电：' + caller);
			});
			await client.login();
			setConnectionState('signedIn');
			setConnectionText('已签入 · 等待来电');
			log('Verto 登录成功');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setErrorMessage(message);
			setConnectionState('idle');
			setConnectionText('签入失败');
			log('签入失败：' + message);
			vertoRef.current?.destroy();
			vertoRef.current = null;
			localStreamRef.current?.getTracks().forEach((track) => track.stop());
			localStreamRef.current = null;
		}
	}

	async function signOut() {
		if (callRef.current) {
			try {
				await callRef.current.hangup();
			} catch {
				callRef.current.clear();
			}
		}
		stopRecording();
		vertoRef.current?.destroy();
		vertoRef.current = null;
		localStreamRef.current?.getTracks().forEach((track) => track.stop());
		localStreamRef.current = null;
		setConnectionState('idle');
		setConnectionText('未签入');
		log('已签出');
	}

	function dial() {
		const client = vertoRef.current;
		const stream = localStreamRef.current;
		const destination = config.destination.trim();
		if (!client || !stream || !destination) return;
		const call = client.call(stream.getTracks(), destination);
		watchCall(call, 'calling', destination);
		void startRecording();
		log('手动外呼：' + destination);
	}

	async function answer() {
		const call = callRef.current;
		const stream = localStreamRef.current;
		if (!call || !stream) return;
		try {
			await startRecording();
			await call.answer(stream.getTracks());
			setCallState('active');
			log('已接听来电');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setErrorMessage(message);
			log('接听失败：' + message);
		}
	}

	async function hangup() {
		if (!callRef.current) return;
		try {
			await callRef.current.hangup();
		} catch {
			callRef.current.clear();
		}
	}

	const signedIn = connectionState === 'signedIn';
	const hasCall = callState !== 'idle';
	const recordingLabel = {
		empty: '暂无录音',
		recording: '录音中',
		saving: '正在保存 WAV…',
		ready: '录音已就绪',
		error: '录音不可用',
	}[recordingState];
	const recordingTime =
		Math.floor(recordingElapsed / 60)
			.toString()
			.padStart(2, '0') +
		':' +
		(recordingElapsed % 60).toString().padStart(2, '0');

	return (
		<main className='app-shell'>
			<h1>Verto 签入测试台</h1>
			<div className='control-grid'>
				<section className='panel' aria-label='Verto 配置和签入'>
					<h2>Verto 配置</h2>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void signIn();
						}}
					>
						<div className='field-grid'>
							<label>
								<span>WebSocket 地址</span>
								<input
									value={config.socketUrl}
									onChange={(event) =>
										updateConfig('socketUrl', event.target.value)
									}
									type='url'
									required
									disabled={signedIn || connectionState === 'signingIn'}
								/>
							</label>
							<label>
								<span>登录域</span>
								<input
									value={config.loginDomain}
									onChange={(event) =>
										updateConfig('loginDomain', event.target.value)
									}
									disabled={signedIn}
								/>
							</label>
							<label>
								<span>分机号</span>
								<input
									value={config.username}
									onChange={(event) =>
										updateConfig('username', event.target.value)
									}
									autoComplete='username'
									required
									disabled={signedIn || connectionState === 'signingIn'}
								/>
							</label>
							<label>
								<span>密码</span>
								<input
									value={config.password}
									onChange={(event) =>
										updateConfig('password', event.target.value)
									}
									type='password'
									autoComplete='current-password'
									required
									disabled={signedIn || connectionState === 'signingIn'}
								/>
							</label>
							<label className='field-wide'>
								<span>
									STUN 地址 <small>可选</small>
								</span>
								<input
									value={config.stunUrl}
									onChange={(event) =>
										updateConfig('stunUrl', event.target.value)
									}
									disabled={signedIn}
								/>
							</label>
						</div>
						<div className='row'>
							<button
								className='success'
								type='submit'
								disabled={signedIn || connectionState === 'signingIn'}
							>
								{connectionState === 'signingIn' ? '签入中…' : '签入'}
							</button>
							<button
								className='neutral'
								type='button'
								onClick={signOut}
								disabled={!signedIn}
							>
								签出
							</button>
						</div>
						<p className='storage-hint'>
							配置（含密码）保存在此浏览器 localStorage，未加密。
						</p>
					</form>
				</section>

				<section className='panel' aria-label='呼叫控制'>
					<h2>呼叫</h2>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							dial();
						}}
					>
						<label>
							<span>被叫号码</span>
							<input
								value={config.destination}
								onChange={(event) =>
									updateConfig('destination', event.target.value)
								}
								inputMode='tel'
								required
								disabled={!signedIn || hasCall}
							/>
						</label>
						<div className='row' style={{ marginTop: '6px' }}>
							<button
								className='primary'
								type='submit'
								disabled={!signedIn || hasCall}
							>
								拨打
							</button>
							<button
								className='danger'
								type='button'
								onClick={hangup}
								disabled={!hasCall}
							>
								挂断
							</button>
						</div>
					</form>
					<p className='status-line' role='status'>
						状态：<strong>{connectionText}</strong>
					</p>
					{hasCall && (
						<p className='call-status'>
							{callState === 'calling'
								? '呼出中'
								: callState === 'ringing'
									? '来电振铃'
									: '通话中'}
							：{callText}
						</p>
					)}
				</section>
			</div>

			{callState === 'ringing' && (
				<section className='panel incoming-panel' aria-label='来电'>
					来电：<strong>{incomingNumber}</strong>
					<div className='row'>
						<button className='success' type='button' onClick={answer}>
							接听
						</button>
						<button className='danger' type='button' onClick={hangup}>
							拒接
						</button>
					</div>
				</section>
			)}
			<audio
				ref={remoteAudioRef}
				className='remote-audio'
				autoPlay
				controls
				aria-label='远端通话音频'
			/>
			<section className='recording-panel' aria-label='通话录音'>
				<div>
					<strong>录音：{recordingLabel}</strong>
					<span>{recordingTime}</span>
				</div>
				{savedRecording && (
					<a
						className='download-recording'
						href={savedRecording.url}
						download={savedRecording.filename}
					>
						下载 WAV
					</a>
				)}
			</section>
			<section className='log-panel' aria-label='运行日志'>
				{errorMessage && (
					<p className='error-message' role='alert'>
						{errorMessage}
					</p>
				)}
				<div
					className='log-output'
					aria-live='polite'
					aria-relevant='additions'
				>
					{logs.length === 0 ? (
						<p className='empty-log'>等待操作…</p>
					) : (
						logs.map((entry, index) => <div key={index}>{entry}</div>)
					)}
				</div>
				<button className='clear-log' type='button' onClick={() => setLogs([])}>
					清空日志
				</button>
			</section>
		</main>
	);
}

export default App;
