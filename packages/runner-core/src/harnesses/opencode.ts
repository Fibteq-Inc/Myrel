import { type Harness, jsonLine, log, num, obj, shellQuote, str, todoStatus } from "../harness";
import type { RunnerEvent, TaskSpec } from "../spec";

/** Provider name Myrel registers in OpenCode's config for OpenAI-compatible models. */
const CUSTOM_PROVIDER = "altair";

/**
 * OpenCode (`opencode run --format json`). The model comes from the task:
 * an OpenAI-compatible endpoint (Fireworks, OpenAI, ...) is registered as a
 * custom provider; Anthropic uses OpenCode's built-in provider. The key is
 * read from ALTAIR_MODEL_API_KEY so it never lands in the config.
 */
export const opencode: Harness = {
  id: "opencode",
  label: "OpenCode",

  command(spec) {
    const model = opencodeModel(spec);
    return ["opencode run --format json", model ? `--model ${shellQuote(model)}` : "", '"$ALTAIR_PROMPT"']
      .filter(Boolean)
      .join(" ");
  },

  env(spec) {
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec)) };
  },

  parse(line) {
    const ev = jsonLine(line);
    if (!ev) return [log(line)];
    const part = obj(ev.part);
    switch (ev.type) {
      case "text": {
        const text = str(part.text)?.trim();
        return text ? [{ type: "text", text }] : [];
      }
      case "tool_use": {
        const tool = str(part.tool) ?? "tool";
        const state = obj(part.state);
        const input = obj(state.input);
        if (tool === "todowrite" && Array.isArray(input.todos)) {
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
        const title = str(state.title) || str(input.description) || str(input.command) || str(input.filePath) || tool;
        const events: RunnerEvent[] = [{ type: "tool", name: tool, title: title.slice(0, 500) }];
        const output = str(state.output);
        if (tool === "bash" && output) events.push(log(output.trimEnd()));
        return events;
      }
      case "step_finish": {
        const tokens = obj(part.tokens);
        return [{ type: "usage", inputTokens: num(tokens.input), outputTokens: num(tokens.output), costUsd: num(part.cost) }];
      }
      case "error": {
        const error = obj(ev.error);
        const message = str(obj(error.data).message) ?? str(error.message) ?? str(error.name) ?? line;
        return [log(message, "stderr")];
      }
      default:
        return [];
    }
  },
};

export function opencodeModel(spec: TaskSpec): string | null {
  const m = spec.model;
  if (!m) return null;
  return m.kind === "anthropic" ? `anthropic/${m.id}` : `${CUSTOM_PROVIDER}/${m.id}`;
}

export function opencodeConfig(spec: TaskSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    // Nobody is there to approve: the sandbox is the boundary.
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  };
  if (spec.mcp) {
    // The token is read from the environment so it never lands in the config.
    config.mcp = {
      altair: { type: "remote", url: spec.mcp.url, enabled: true, headers: { Authorization: "Bearer {env:ALTAIR_MCP_TOKEN}" } },
    };
  }
  const m = spec.model;
  if (!m) return config;
  const apiKey = "{env:ALTAIR_MODEL_API_KEY}";
  config.provider =
    m.kind === "anthropic"
      ? { anthropic: { options: { apiKey, ...(m.baseUrl ? { baseURL: `${m.baseUrl.replace(/\/+$/, "")}/v1` } : {}) } } }
      : {
          [CUSTOM_PROVIDER]: {
            npm: "@ai-sdk/openai-compatible",
            name: `Myrel (${m.provider})`,
            options: { baseURL: m.baseUrl, apiKey },
            // OpenCode passes an image file it reads to the model only when the model says it takes images.
            models: {
              [m.id]: {
                name: m.id,
                tool_call: true,
                ...(m.images && { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } }),
              },
            },
          },
        };
  return config;
}
