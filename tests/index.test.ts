import { expect, test } from '@rstest/core';
import {
  JsonRpcClient,
  VertoBase,
  type WebSocketLike,
} from '../src/index';
import { encodeWav } from '../demo/src/wav';

class FakeSocket implements WebSocketLike {
  public static instances: FakeSocket[] = [];
  public readonly sent: string[] = [];
  public readyState = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;

  public constructor() {
    FakeSocket.instances.push(this);
  }

  public open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  public close(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

test('event subscriptions can be removed by ID', () => {
  const emitter = new VertoBase<{ change: number }>();
  const values: number[] = [];
  const id = emitter.on('change', (value) => values.push(value));

  emitter.dispatchEvent('change', 1);
  emitter.off('change', id);
  emitter.dispatchEvent('change', 2);

  expect(values).toEqual([1]);
});

test('JSON-RPC queues calls until the socket opens and resolves typed results', async () => {
  FakeSocket.instances = [];
  const client = new JsonRpcClient({
    socketUrl: 'wss://example.test/verto',
    reconnect: false,
    socketFactory: () => new FakeSocket(),
  });

  const resultPromise = client.call<{ ok: boolean }>('ping', { value: 1 });
  const socket = FakeSocket.instances[0];
  expect(socket.sent).toEqual([]);

  socket.open();
  const request = JSON.parse(socket.sent[0]) as { id: number };
  socket.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));

  expect(await resultPromise).toEqual({ ok: true });
  client.close();
});

test('connect resolves on the initial WebSocket open event', async () => {
  FakeSocket.instances = [];
  const client = new JsonRpcClient({
    socketUrl: 'wss://example.test/verto',
    reconnect: false,
    socketFactory: () => new FakeSocket(),
  });
  const connection = client.connect();

  FakeSocket.instances[0].open();
  await connection;
  client.close();
});

test('WAV export writes a PCM header and signed 16-bit samples', async () => {
  const samples = new Float32Array([-1, 0, 1]);
  const audioBuffer = {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: 8000,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;

  const wav = encodeWav(audioBuffer);
  const bytes = await wav.arrayBuffer();
  const view = new DataView(bytes);
  const text = new TextDecoder();

  expect(wav.type).toBe('audio/wav');
  expect(text.decode(bytes.slice(0, 4))).toBe('RIFF');
  expect(text.decode(bytes.slice(8, 12))).toBe('WAVE');
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(8000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(46, true)).toBe(0);
  expect(view.getInt16(48, true)).toBe(32767);
});
