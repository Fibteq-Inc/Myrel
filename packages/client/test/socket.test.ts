import { createId, type Message } from "@myrel/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSocket } from "../src/socket";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const projectId = createId("project");
const msg = (seq: number): Message => ({
  id: createId("message"),
  projectId,
  threadId: null,
  authorKind: "user",
  authorId: "u1",
  body: `m${seq}`,
  seq,
  createdAt: new Date().toISOString(),
});

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

describe("ProjectSocket", () => {
  it("asks for the newest messages, catches up to the project's last seq, and starts over on a reset", async () => {
    vi.useFakeTimers();
    const received: number[] = [];
    new ProjectSocket({
      url: () => "ws://test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      recent: 60,
      onMessage: (m) => received.push(m.seq),
    }).connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    expect(ws.sent).toEqual([{ type: "sync", afterSeq: 0, all: true, recent: 60 }]);

    // The chat's newest is 4; a thread's message 9 is newer: the next live message follows on from 9.
    ws.receive({ type: "sync.result", messages: [msg(3), msg(4)], hasMore: false, lastSeq: 9 });
    ws.receive({ type: "message.created", message: msg(10) });
    expect(ws.sent).toHaveLength(1);

    ws.receive({ type: "sync.result", messages: [msg(2)], hasMore: false, reset: true, lastSeq: 12 });
    ws.receive({ type: "message.created", message: msg(13) });
    expect(received).toEqual([3, 4, 10, 2, 13]);
  });

  it("syncs on open, fills gaps and resumes from the last seq after reconnect", async () => {
    vi.useFakeTimers();
    const received: number[] = [];
    const socket = new ProjectSocket({
      url: () => "ws://test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: (m) => received.push(m.seq),
    }).connect();

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    expect(first.sent).toEqual([{ type: "sync", afterSeq: 0, all: true }]);

    first.receive({ type: "sync.result", messages: [msg(1), msg(2)], hasMore: false });
    first.receive({ type: "message.created", message: msg(3) });
    first.receive({ type: "message.created", message: msg(3) }); // duplicate ignored
    first.receive({ type: "message.created", message: msg(5) }); // gap -> sync
    expect(first.sent.at(-1)).toEqual({ type: "sync", afterSeq: 3, all: true });
    first.receive({ type: "sync.result", messages: [msg(4), msg(5)], hasMore: false });
    expect(received).toEqual([1, 2, 3, 4, 5]);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    socket.sendMessage("queued while offline");
    second.open();
    expect(second.sent).toEqual([
      { type: "sync", afterSeq: 5, all: true },
      { type: "message.send", body: "queued while offline", threadId: null },
    ]);
    socket.close();
  });

  it("takes a streamed sync page by page without asking again, and hands each page over at once", async () => {
    vi.useFakeTimers();
    const batches: number[][] = [];
    let synced = 0;
    const socket = new ProjectSocket({
      url: () => "ws://test",
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      onMessages: (ms) => batches.push(ms.map((m) => m.seq)),
      onSynced: () => synced++,
    }).connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: "sync.result", messages: [msg(1), msg(2)], hasMore: true, streamed: true });
    expect(ws.sent).toHaveLength(1);
    expect(synced).toBe(0);
    ws.receive({ type: "sync.result", messages: [msg(3)], hasMore: false, streamed: true });
    expect(batches).toEqual([[1, 2], [3]]);
    expect(synced).toBe(1);
    socket.close();
  });

  it("asks for the next page itself when the server does not stream", async () => {
    vi.useFakeTimers();
    const socket = new ProjectSocket({ url: () => "ws://test", WebSocket: FakeWebSocket as unknown as typeof WebSocket }).connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive({ type: "sync.result", messages: [msg(1)], hasMore: true });
    expect(ws.sent.at(-1)).toEqual({ type: "sync", afterSeq: 1, all: true });
    socket.close();
  });
});
