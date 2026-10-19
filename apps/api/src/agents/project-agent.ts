import {
  type AuthorKind,
  ClientEvent,
  createId,
  type Message,
  type ServerEvent,
  SYNC_PAGE_SIZE,
} from "@altair/protocol";
import { Agent, type Connection, type ConnectionContext } from "agents";

/** Header the API Worker sets after authenticating a WebSocket upgrade. */
export const USER_ID_HEADER = "x-altair-user-id";

type ConnState = { userId: string };

type MessageRow = {
  seq: number;
  id: string;
  thread_id: string | null;
  author_kind: AuthorKind;
  author_id: string;
  body: string;
  created_at: string;
};

export type NewMessage = Pick<Message, "threadId" | "authorKind" | "authorId" | "body">;

/**
 * One instance per project (named by project id). Owns the project chat:
 * messages live in this DO's SQLite with a monotonically increasing `seq`
 * so clients can resume with "give me everything after seq N".
 */
export class ProjectAgent extends Agent<Env> {
  static override options = { sendIdentityOnConnect: false };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      author_kind TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }

  // Our clients speak the Altair protocol only; skip the SDK's state/identity frames.
  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  override onConnect(connection: Connection, { request }: ConnectionContext) {
    const userId = request.headers.get(USER_ID_HEADER);
    if (!userId) {
      connection.close(4401, "unauthorized");
      return;
    }
    connection.setState({ userId });
  }

  override onMessage(connection: Connection, raw: string | ArrayBuffer | ArrayBufferView) {
    const userId = (connection.state as ConnState | null)?.userId;
    if (!userId) return connection.close(4401, "unauthorized");

    let data: unknown;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return send(connection, { type: "error", code: "bad_json", message: "Invalid JSON" });
    }
    const parsed = ClientEvent.safeParse(data);
    if (!parsed.success) {
      return send(connection, { type: "error", code: "bad_event", message: parsed.error.message });
    }

    const event = parsed.data;
    switch (event.type) {
      case "message.send": {
        const message = this.sendMessage({
          threadId: event.threadId,
          authorKind: "user",
          authorId: userId,
          body: event.body,
        });
        if (event.clientId) {
          send(connection, { type: "message.ack", clientId: event.clientId, messageId: message.id, seq: message.seq });
        }
        return;
      }
      case "sync":
        return send(connection, { type: "sync.result", ...this.getMessagesAfter(event.afterSeq) });
    }
  }

  /** Store a message and broadcast it to every connected client. Callable over RPC. */
  sendMessage(input: NewMessage): Message {
    const id = createId("message");
    const createdAt = new Date().toISOString();
    const [row] = this.sql<{ seq: number }>`
      INSERT INTO messages (id, thread_id, author_kind, author_id, body, created_at)
      VALUES (${id}, ${input.threadId}, ${input.authorKind}, ${input.authorId}, ${input.body}, ${createdAt})
      RETURNING seq`;
    const message: Message = { ...input, id, projectId: this.name, seq: row!.seq, createdAt };
    this.broadcast(JSON.stringify({ type: "message.created", message } satisfies ServerEvent));
    return message;
  }

  /** Messages with seq > afterSeq, oldest first. Callable over RPC. */
  getMessagesAfter(afterSeq: number, limit = SYNC_PAGE_SIZE): { messages: Message[]; hasMore: boolean } {
    const rows = this.sql<MessageRow>`
      SELECT * FROM messages WHERE seq > ${afterSeq} ORDER BY seq LIMIT ${limit + 1}`;
    return { messages: rows.slice(0, limit).map((r) => this.toMessage(r)), hasMore: rows.length > limit };
  }

  private toMessage(r: MessageRow): Message {
    return {
      id: r.id,
      projectId: this.name,
      threadId: r.thread_id,
      authorKind: r.author_kind,
      authorId: r.author_id,
      body: r.body,
      seq: r.seq,
      createdAt: r.created_at,
    };
  }
}

function send(connection: Connection, event: ServerEvent) {
  connection.send(JSON.stringify(event));
}
