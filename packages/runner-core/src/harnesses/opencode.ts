import { type Harness, jsonLine, log, num, obj, shellQuote, str, todoStatus } from "../harness";
import type { RunnerEvent, TaskSpec } from "../spec";

/** Provider name Myrel registers in OpenCode's config for OpenAI-compatible models. */
const CUSTOM_PROVIDER = "myrel";

/**
 * OpenCode (`opencode run --format json`). The model comes from the task:
 * an OpenAI-compatible endpoint (Fireworks, OpenAI, ...) is registered as a
 * custom provider; Anthropic uses OpenCode's built-in provider. The key is
 * read from MYREL_MODEL_API_KEY so it never lands in the config.
 */
export const opencode: Harness = {
  id: "opencode",
  label: "OpenCode",

  command(spec) {
    const model = opencodeModel(spec);
    const run = ["opencode run --format json", model ? `--model ${shellQuote(model)}` : "", '"$MYREL_PROMPT"'].filter(Boolean).join(" ");
    // The plan plugin is a file OpenCode imports; its source comes in the environment.
    return spec.mcp ? `mkdir -p "$(dirname "${PLAN_PLUGIN_FILE}")" && printf '%s' "$MYREL_PLAN_PLUGIN" > "${PLAN_PLUGIN_FILE}" && ${run}` : run;
  },

  env(spec) {
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(spec)),
      ...(spec.mcp && { MYREL_PLAN_PLUGIN: PLAN_PLUGIN }),
    };
  },

  parse(line) {
    const ev = jsonLine(line);
    if (!ev) {
      // `opencode run` rejects whatever asks for approval, since nobody can answer it there.
      const rejected = line.replace(/\x1b\[[0-9;]*m/g, "").match(/permission requested: (.+?); auto-rejecting/);
      if (rejected) return [log(`OpenCode was not allowed to use ${rejected[1]}: it needed approval, which nobody can give in the sandbox.`, "stderr")];
      return [log(line)];
    }
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
        // OpenCode reports a tool once it finished, with when it started and ended.
        const time = obj(state.time);
        const ms = num(time.end) - num(time.start);
        const events: RunnerEvent[] = [{ type: "tool", name: tool, title: title.slice(0, 500), ...(num(time.start) > 0 && ms >= 0 && { ms }) }];
        const output = str(state.output);
        // The plan plugin's reminder is for the agent, not for people watching the terminal.
        const shown = output?.replace(PLAN_REMINDER, "");
        if (tool === "bash" && shown) events.push(log(settleProgress(shown).trimEnd()));
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

/** The reminder PLAN_PLUGIN appends to a tool's output. */
const PLAN_REMINDER = /\n\n\[Myrel\] Your plan still shows [\s\S]*$/;

/** Where the task writes the plan plugin ($HOME is the task's own home). */
const PLAN_PLUGIN_FILE = "$HOME/.cache/myrel/opencode-plan.js";

/**
 * An OpenCode plugin that keeps the plan honest while the agent works. Weaker models set the plan
 * up front and then tick every step at the very end, so people watch a plan that never moves.
 * Once a few tool calls went by since the plan last changed, the next tool result tells the agent
 * which step is still active and asks it to mark that step done if its work is.
 */
export const PLAN_PLUGIN = `export const MyrelPlan = async () => {
  let active = null;
  let since = 0;
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool === "myrel_update_plan") {
        const steps = Array.isArray(input.args?.steps) ? input.args.steps : [];
        active = steps.find((s) => s && s.state === "active")?.text ?? null;
        since = 0;
        return;
      }
      if (!active || input.tool.startsWith("myrel_") || typeof output?.output !== "string") return;
      since++;
      if (since % 3 !== 2) return;
      output.output += "\\n\\n[Myrel] Your plan still shows \\"" + active + "\\" as the active step. If its work is done, call myrel_update_plan now to mark it done and the next step active, then go on. If not, carry on.";
    },
  };
};
`;

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
    // Nobody is there to approve, so anything that asks is rejected: the sandbox is the boundary.
    // external_directory covers the folders next to the saved one (repos, files, skills).
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" },
  };
  if (spec.mcp) {
    // The token is read from the environment so it never lands in the config.
    const auth = { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" };
    const servers: Record<string, unknown> = { myrel: { type: "remote", url: spec.mcp.url, enabled: true, headers: auth } };
    for (const c of spec.mcp.connectors ?? []) {
      servers[c.name] =
        c.transport === "http"
          ? { type: "remote", url: c.url, enabled: true, headers: auth }
          : {
              type: "local",
              command: [c.command, ...c.args],
              enabled: true,
              environment: Object.fromEntries(Object.entries(c.env).map(([name, secret]) => [name, `{env:${secret}}`])),
            };
    }
    config.mcp = servers;
    config.plugin = [`file://${PLAN_PLUGIN_FILE.replace("$HOME", "{env:HOME}")}`];
  }
  const m = spec.model;
  if (!m) return config;
  const apiKey = "{env:MYREL_MODEL_API_KEY}";
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

/**
 * Progress lines (git's "Updating files: 15%…") redraw themselves with carriage returns; keep only
 * what each line finally showed, as a terminal would.
 */
export function settleProgress(text: string): string {
  return text
    .split("\n")
    .map((line) => line.split("\r").filter((part) => part.length > 0).pop() ?? "")
    .join("\n");
}
