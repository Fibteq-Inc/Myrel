import { type Harness, jsonLine, log, num, obj, shellQuote, str } from "../harness";
import type { RunnerEvent, TaskSpec } from "../spec";

/** Provider name Myrel registers in Codex's config for the task's model. */
const PROVIDER = "myrel";

/**
 * Codex CLI (`codex exec --json`). OpenAI-compatible models that speak the Responses API (the only
 * one Codex does): the model is registered as a provider whose key Codex reads from
 * MYREL_MODEL_API_KEY, so it never lands in the config or on the command line.
 *
 * `codex exec` cannot ask anything, so its own sandbox is off (the container is the boundary, as
 * for OpenCode) and Myrel's MCP server and connectors are pre-approved, as on the runner.
 */
export const codex: Harness = {
  id: "codex",
  label: "Codex",

  command(spec) {
    const args = ["codex exec --json --skip-git-repo-check --sandbox danger-full-access", ...codexArgs(spec).map(shellQuote), "-"];
    // The prompt goes on stdin: `-` reads it there.
    return `printf '%s' "$MYREL_PROMPT" | ${args.join(" ")}`;
  },

  env() {
    return {};
  },

  parse(line) {
    const ev = jsonLine(line);
    if (!ev) return [log(line)];
    const item = obj(ev.item);
    switch (ev.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        return codexItem(String(ev.type), item);
      case "turn.completed": {
        const usage = obj(ev.usage);
        return [{ type: "usage", inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) }];
      }
      case "turn.failed":
        return [log(str(obj(ev.error).message) ?? "Codex failed.", "stderr")];
      case "error":
        return [log(str(ev.message) ?? line, "stderr")];
      default:
        return [];
    }
  },
};

function codexItem(type: string, item: Record<string, unknown>): RunnerEvent[] {
  switch (item.type) {
    case "agent_message": {
      const text = type === "item.completed" ? str(item.text)?.trim() : undefined;
      return text ? [{ type: "text", text }] : [];
    }
    case "todo_list": {
      if (!Array.isArray(item.items)) return [];
      return [
        {
          type: "todos",
          items: item.items.slice(0, 50).map((t) => {
            const todo = obj(t);
            return { text: (str(todo.text) ?? "").slice(0, 300), status: todo.completed === true ? "done" : "pending" };
          }),
        },
      ];
    }
    case "command_execution": {
      const command = unwrapShell(str(item.command) ?? "");
      if (type === "item.started") return [{ type: "tool", name: "bash", title: command.slice(0, 500) || "bash" }];
      const output = type === "item.completed" ? str(item.aggregated_output)?.trimEnd() : undefined;
      return output ? [log(output)] : [];
    }
    case "file_change": {
      if (type !== "item.completed" || !Array.isArray(item.changes)) return [];
      const paths = item.changes.map((c) => str(obj(c).path)).filter(Boolean);
      return [{ type: "tool", name: "edit", title: (paths.join(", ") || "files").slice(0, 500) }];
    }
    case "mcp_tool_call":
      return type === "item.started" ? [{ type: "tool", name: "mcp", title: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`.slice(0, 500) }] : [];
    case "web_search":
      return type === "item.started" ? [{ type: "tool", name: "web_search", title: (str(item.query) ?? "web search").slice(0, 500) }] : [];
    case "error":
      return type === "item.completed" ? [log(str(item.message) ?? "Codex reported an error.", "stderr")] : [];
    default:
      return [];
  }
}

/** Codex runs a command as `bash -lc '<command>'`; people want to see the command. */
function unwrapShell(command: string): string {
  const c = command.trim();
  for (const shell of ["/bin/bash", "/usr/bin/bash", "bash", "/bin/sh", "sh", "/bin/zsh", "zsh"]) {
    for (const flag of [" -lc ", " -c "]) {
      const head = shell + flag;
      const quote = c[head.length];
      if (c.startsWith(head) && (quote === "'" || quote === '"') && c.length > head.length + 1 && c.endsWith(quote)) {
        return c.slice(head.length + 1, -1);
      }
    }
  }
  return c;
}

/** TOML string: a JSON string is a valid TOML basic string. */
const toml = (s: string) => JSON.stringify(s);

/** The `-c key=value` config overrides and the model for one run. */
export function codexArgs(spec: TaskSpec): string[] {
  const args: string[] = ["-c", "check_for_update_on_startup=false"];
  const m = spec.model;
  if (m?.kind === "openai" && m.baseUrl) {
    const provider = `{ name = ${toml(`Myrel (${m.provider})`)}, base_url = ${toml(m.baseUrl)}, env_key = "MYREL_MODEL_API_KEY", wire_api = "responses" }`;
    args.push("-c", `model_providers.${PROVIDER}=${provider}`, "-c", `model_provider=${toml(PROVIDER)}`, "-m", m.id);
  }
  if (!spec.mcp) return args;
  // Nobody can approve a tool mid-run: people approve in the thread, so these are pre-approved.
  const approve = (name: string) => ["-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`];
  const remote = (name: string, url: string) => [
    "-c",
    `mcp_servers.${name}.url=${toml(url)}`,
    "-c",
    `mcp_servers.${name}.bearer_token_env_var="MYREL_MCP_TOKEN"`,
    ...approve(name),
  ];
  args.push(...remote("myrel", spec.mcp.url));
  for (const c of spec.mcp.connectors ?? []) {
    if (c.transport === "http") {
      args.push(...remote(c.name, c.url));
      continue;
    }
    // A command's variables hold secrets: they stay in the environment under the names Myrel gave
    // them (forwarded with env_vars) and are renamed only inside the command's own shell, so no
    // value is ever on a command line or in the config.
    const vars = Object.entries(c.env);
    const exports = vars.map(([name, secret]) => `export ${name}="$${secret}"; `).join("");
    const command = vars.length ? "sh" : c.command;
    const cargs = vars.length ? ["-c", `${exports}exec "$0" "$@"`, c.command, ...c.args] : c.args;
    args.push("-c", `mcp_servers.${c.name}.command=${toml(command)}`, "-c", `mcp_servers.${c.name}.args=${JSON.stringify(cargs)}`);
    if (vars.length) args.push("-c", `mcp_servers.${c.name}.env_vars=${JSON.stringify(vars.map(([, secret]) => secret))}`);
    args.push(...approve(c.name));
  }
  return args;
}
