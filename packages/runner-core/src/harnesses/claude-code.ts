import { type Harness, jsonLine, log, num, obj, shellQuote, str, todoStatus } from "../harness";
import type { RunnerEvent, TaskSpec } from "../spec";

/** Where the task writes Claude Code's MCP config, with the tokens filled in ($HOME is the task's own home). */
const MCP_FILE = "$HOME/.cache/myrel/claude-mcp.json";

/**
 * Fills `{env:NAME}` in the config's headers and command variables from the environment, so the
 * config travels without secrets and only the private file written right before the run holds them.
 */
const FILL_ENV = `.mcpServers |= map_values(
  (if .headers then .headers |= map_values(gsub("[{]env:(?<n>[A-Z_][A-Z0-9_]*)[}]"; $ENV[.n] // "")) else . end)
  | (if .env then .env |= map_values(gsub("[{]env:(?<n>[A-Z_][A-Z0-9_]*)[}]"; $ENV[.n] // "")) else . end))`;

/**
 * Claude Code (`claude -p --output-format stream-json`). Claude models only.
 * In the cloud it reaches the model through Myrel (ANTHROPIC_BASE_URL) with the turn's token as its
 * key, so no real key enters the sandbox; without a model it uses the CLI's own login.
 */
export const claudeCode: Harness = {
  id: "claude-code",
  label: "Claude Code",

  command(spec) {
    const cloud = spec.model?.kind === "anthropic";
    const claude = [
      cloud ? 'ANTHROPIC_API_KEY="$MYREL_MODEL_API_KEY"' : "",
      "claude -p --output-format stream-json --verbose --dangerously-skip-permissions",
      cloud ? `--model ${shellQuote(spec.model!.id)}` : "",
      // Strict: only Myrel's servers. --mcp-config takes several files, so the prompt goes on stdin.
      spec.mcp ? `--mcp-config "${MCP_FILE}" --strict-mcp-config` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const run = `printf '%s' "$MYREL_PROMPT" | ${claude}`;
    if (!spec.mcp) return run;
    return [
      `mkdir -p "$(dirname "${MCP_FILE}")"`,
      `(umask 077 && printf '%s' "$MYREL_CLAUDE_MCP" | jq -c "$MYREL_CLAUDE_MCP_FILL" > "${MCP_FILE}") || exit 1`,
      run,
      // The file holds the tokens: it goes as soon as the run ends.
      `CODE=$?; rm -f "${MCP_FILE}"; exit $CODE`,
    ].join("\n");
  },

  env(spec) {
    const env: Record<string, string> = {};
    if (spec.mcp) Object.assign(env, { MYREL_CLAUDE_MCP: JSON.stringify(claudeMcpConfig(spec)), MYREL_CLAUDE_MCP_FILL: FILL_ENV });
    // Only when the task carries a model: otherwise the local CLI's own login is used.
    if (spec.model?.kind !== "anthropic") return env;
    const id = spec.model.id;
    return {
      ...env,
      ...(spec.model.baseUrl ? { ANTHROPIC_BASE_URL: spec.model.baseUrl } : {}),
      // Every call Claude Code makes on its own (titles, subagents) uses the task's model too, the
      // one the proxy prices and the project pays for.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
      ANTHROPIC_DEFAULT_SONNET_MODEL: id,
      ANTHROPIC_DEFAULT_OPUS_MODEL: id,
      CLAUDE_CODE_SUBAGENT_MODEL: id,
      // Nothing leaves the sandbox but the model calls through Myrel: no telemetry, error reports or update checks.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    };
  },

  parse(line) {
    const ev = jsonLine(line);
    if (!ev) return [log(line)];
    if (ev.type === "assistant") {
      const content = obj(ev.message).content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((raw): RunnerEvent[] => {
        const block = obj(raw);
        if (block.type === "text") {
          const text = str(block.text)?.trim();
          return text ? [{ type: "text", text }] : [];
        }
        if (block.type !== "tool_use") return [];
        const name = str(block.name) ?? "tool";
        const input = obj(block.input);
        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          return [
            {
              type: "todos",
              items: input.todos.slice(0, 50).map((t) => {
                const todo = obj(t);
                return { text: (str(todo.content) ?? "").slice(0, 300), status: todoStatus(todo.status) };
              }),
            },
          ];
        }
        const title = str(input.description) || str(input.command) || str(input.file_path) || name;
        return [{ type: "tool", name, title: title.slice(0, 500) }];
      });
    }
    if (ev.type === "result") {
      const usage = obj(ev.usage);
      const events: RunnerEvent[] = [
        {
          type: "usage",
          inputTokens: num(usage.input_tokens),
          outputTokens: num(usage.output_tokens),
          costUsd: num(ev.total_cost_usd),
        },
      ];
      if (ev.is_error) events.push(log(str(ev.result) ?? "Claude Code failed.", "stderr"));
      return events;
    }
    return [];
  },
};

/** Claude Code's MCP config for the task: Myrel's tools and the thread's connectors, secrets as `{env:NAME}`. */
export function claudeMcpConfig(spec: TaskSpec): Record<string, unknown> {
  if (!spec.mcp) return { mcpServers: {} };
  const headers = { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" };
  // alwaysLoad: Myrel's own tools go in the first model call rather than behind ToolSearch.
  const servers: Record<string, unknown> = { myrel: { type: "http", url: spec.mcp.url, headers, alwaysLoad: true } };
  for (const c of spec.mcp.connectors ?? []) {
    servers[c.name] =
      c.transport === "http"
        ? { type: "http", url: c.url, headers }
        : {
            type: "stdio",
            command: c.command,
            args: c.args,
            env: Object.fromEntries(Object.entries(c.env).map(([name, secret]) => [name, `{env:${secret}}`])),
          };
  }
  return { mcpServers: servers };
}
