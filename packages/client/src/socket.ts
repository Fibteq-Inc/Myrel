import { type ClientEventInput, type Message, ServerEvent } from "@altair/protocol";

export type SocketStatus = "connecting" | "open" | "closed";

export type ProjectSocketOptions = {
  /** Resolves the URL on every (re)connect, so a refreshed token is picked up. */
  url: () => string | Promise<string>;
  /** Highest seq the caller already has (e.g. from a local cache). */
  lastSeq?: number;
  onMessage?: (message: Message) => void;
  onEvent?: (event: ServerEvent) => void;
  onStatus?: (status: SocketStatus) => void;
  WebSocket?: typeof WebSocket;
  /** Backoff bounds in ms. */
  minDelay?: number;
  maxDelay?: number;
};

/**
 * Project live channel. Reconnects with exponential backoff and, on every
 * open, asks for messages after the highest seq it has seen, so nothing is
 * lost across drops. Messages are delivered once, in seq order.
 */
export class ProjectSocket {
  private ws: WebSocket | null = null;
  private lastSeq: number;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private outbox: string[] = [];
  private syncing = false;

  constructor(private readonly opts: ProjectSocketOptions) {
    this.lastSeq = opts.lastSeq ?? 0;
  }

  get seq() {
    return this.lastSeq;
  }

  connect() {
    this.stopped = false;
    void this.open();
    return this;
  }

  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
  }

  send(event: ClientEventInput) {
    const data = JSON.stringify(event);
    if (this.ws?.readyState === 1) this.ws.send(data);
    else this.outbox.push(data);
  }

  sendMessage(body: string, opts: { threadId?: string | null; clientId?: string } = {}) {
    this.send({ type: "message.send", body, threadId: opts.threadId ?? null, clientId: opts.clientId });
  }

  private async open() {
    this.opts.onStatus?.("connecting");
    let url: string;
    try {
      url = await this.opts.url();
    } catch {
      return this.scheduleReconnect();
    }
    if (this.stopped) return;

    const WS = this.opts.WebSocket ?? WebSocket;
    const ws = new WS(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.("open");
      this.syncing = false;
      this.requestSync();
      for (const data of this.outbox.splice(0)) ws.send(data);
    };
    ws.onmessage = (e) => this.handle(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onStatus?.("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private handle(data: unknown) {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = ServerEvent.safeParse(parsed);
    if (!result.success) return;
    const event = result.data;
    this.opts.onEvent?.(event);

    if (event.type === "message.created") {
      const { seq } = event.message;
      if (seq === this.lastSeq + 1) this.deliver(event.message);
      // A gap means we missed something: fetch it (the sync result includes this message too).
      else if (seq > this.lastSeq + 1) this.requestSync();
    } else if (event.type === "sync.result") {
      this.syncing = false;
      for (const m of event.messages) this.deliver(m);
      if (event.hasMore) this.requestSync();
    }
  }

  private requestSync() {
    if (this.syncing || this.ws?.readyState !== 1) return;
    this.syncing = true;
    this.ws.send(JSON.stringify({ type: "sync", afterSeq: this.lastSeq } satisfies ClientEventInput));
  }

  private deliver(message: Message) {
    if (message.seq <= this.lastSeq) return;
    this.lastSeq = message.seq;
    this.opts.onMessage?.(message);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const min = this.opts.minDelay ?? 500;
    const max = this.opts.maxDelay ?? 15_000;
    const delay = Math.min(max, min * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.timer = setTimeout(() => void this.open(), delay);
  }
}
