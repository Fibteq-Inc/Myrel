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
    expect(first.sent).toEqual([{ type: "sync", afterSeq: 0 }]);

    first.receive({ type: "sync.result", messages: [msg(1), msg(2)], hasMore: false });
    first.receive({ type: "message.created", message: msg(3) });
    first.receive({ type: "message.created", message: msg(3) }); // duplicate ignored
    first.receive({ type: "message.created", message: msg(5) }); // gap -> sync
    expect(first.sent.at(-1)).toEqual({ type: "sync", afterSeq: 3 });
    first.receive({ type: "sync.result", messages: [msg(4), msg(5)], hasMore: false });
    expect(received).toEqual([1, 2, 3, 4, 5]);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1]!;
    socket.sendMessage("queued while offline");
    second.open();
    expect(second.sent).toEqual([
      { type: "sync", afterSeq: 5 },
      { type: "message.send", body: "queued while offline", threadId: null },
    ]);
    socket.close();
  });
});
