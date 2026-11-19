/** Verto 对象事件监听器。 */
export type EventListener<T> = (data: T) => void;

type EventName<Events extends object> = Extract<keyof Events, string>;

/**
 * Creates a UUID without importing a Node-only module.
 *
 * Verto is commonly used from browser bundles and from SSR applications, so
 * the implementation only reads globalThis.crypto when it is available.
 */
export function generateGUID(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10).join(''),
    ].join('-');
  }
  // Last-resort fallback for runtimes without Web Crypto.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Small framework-neutral event emitter used by the RPC, RTC and call layers.
 *
 * Subscriptions return an ID, which makes cleanup straightforward in React,
 * Vue, Svelte and plain DOM applications alike.
 */
export class VertoBase<Events extends object = Record<string, unknown>> {
  private readonly eventHandlers = new Map<string, Map<string, EventListener<unknown>>>();
  public readonly debug: boolean;

  /**
   * 创建一个可订阅事件的基础对象。
   *
   * @param debug 是否输出事件调试日志。
   */
  public constructor(debug = false) {
    this.debug = debug;
  }

  /**
   * 订阅事件。
   *
   * @param name 事件名称，具体可用事件由对象的事件类型决定。
   * @param handler 事件回调，参数类型与事件对应。
   * @returns 订阅 ID，调用 unsubscribeEvent 或 off 时使用。
   */
  public subscribeEvent<Name extends EventName<Events>>(
    name: Name,
    handler: EventListener<Events[Name]>,
  ): string {
    const id = generateGUID();
    const handlers = this.eventHandlers.get(name) ?? new Map();
    handlers.set(id, handler as EventListener<unknown>);
    this.eventHandlers.set(name, handlers);
    return id;
  }

  /**
   * 订阅事件的简写形式。
   *
   * @param name 事件名称。
   * @param handler 事件回调。
   * @returns 订阅 ID。
   */
  public on<Name extends EventName<Events>>(
    name: Name,
    handler: EventListener<Events[Name]>,
  ): string {
    return this.subscribeEvent(name, handler);
  }

  /**
   * 移除事件订阅。
   *
   * @param name 事件名称。
   * @param handlerId 要移除的订阅 ID；省略时移除该事件的全部订阅。
   */
  public unsubscribeEvent<Name extends EventName<Events>>(name: Name, handlerId?: string): void {
    if (!handlerId) {
      this.eventHandlers.delete(name);
      return;
    }
    const handlers = this.eventHandlers.get(name);
    handlers?.delete(handlerId);
    if (handlers && handlers.size === 0) this.eventHandlers.delete(name);
  }

  /**
   * 移除事件订阅的简写形式。
   *
   * @param name 事件名称。
   * @param handlerId 要移除的订阅 ID；省略时移除该事件的全部订阅。
   */
  public off<Name extends EventName<Events>>(name: Name, handlerId?: string): void {
    this.unsubscribeEvent(name, handlerId);
  }

  /**
   * 向当前对象派发事件。
   *
   * 此方法主要供库内部使用；应用层通常应使用 on 或 subscribeEvent。
   *
   * @param name 事件名称。
   * @param data 事件载荷。
   */
  public dispatchEvent<Name extends EventName<Events>>(name: Name, data: Events[Name]): void {
    if (this.debug) console.debug('[verto:event]', name, data);
    // Snapshot listeners so a handler can unsubscribe itself safely.
    const handlers = this.eventHandlers.get(name);
    if (!handlers) return;
    for (const handler of [...handlers.values()]) handler(data);
  }

  /** 移除当前对象注册的全部事件监听器。 */
  public removeAllListeners(): void {
    this.eventHandlers.clear();
  }
}
