import { type Harness, jsonLine, log, num, obj, shellQuote, str, todoStatus } from "../harness";
import type { RunnerEvent, TaskSpec } from "../spec";

/** Provider name Myrel registers in OpenCode's config for OpenAI-compatible models. */
const CUSTOM_PROVIDER = "myrel";

/**
 * OpenCode 2 (`opencode run --standalone --format json`; standalone, because the shared background
 * service would ignore the run's environment config). The model comes from the task:
 * an OpenAI-compatible endpoint (Fireworks, OpenAI, ...) is registered as a
 * custom provider; Anthropic uses OpenCode's built-in provider. The key is
 * read from MYREL_MODEL_API_KEY so it never lands in the config.
 */
export const opencode: Harness = {
  id: "opencode",
  label: "OpenCode",

  command(spec) {
    const model = opencodeModel(spec);
    const run = ["opencode run --standalone --format json", model ? `--model ${shellQuote(model)}` : "", '"$MYREL_PROMPT"'].filter(Boolean).join(" ");
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
        if ((tool === "todowrite" || tool === "todo") && Array.isArray(input.todos)) {
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
        // OpenCode 2 calls the command tool shell (1 called it bash); its output is terminal output.
        if ((tool === "bash" || tool === "shell") && shown) events.push(log(settleProgress(shown).trimEnd()));
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

/** The reminder the plan plugin gives the agent, should it ever land in a tool's output. */
const PLAN_REMINDER = /\n\n\[Myrel\] Your plan still shows [\s\S]*$/;

/** Where the task writes the plan plugin ($HOME is the task's own home). OpenCode 2 loads a local plugin from a directory. */
const PLAN_PLUGIN_FILE = "$HOME/.cache/myrel/opencode-plan/index.js";

/** The plan plugin's directory as the config names it, with the home read from the environment. */
const PLAN_PLUGIN_DIR = "{env:HOME}/.cache/myrel/opencode-plan";

/**
 * An OpenCode 2 plugin that keeps the plan honest while the agent works. Weaker models set the plan
 * up front and then tick every step at the very end, so people watch a plan that never moves.
 * OpenCode 2 has no after-tool hook, so the plugin watches each model call's context instead: once
 * a few calls went by since the plan last changed, the next call's instructions name the step that
 * is still active and ask the agent to mark it done if its work is. Everything is defensive: the
 * messages' inner shape is OpenCode's, so the plugin walks them loosely for plan calls and does
 * nothing at all when it cannot find one.
 */
export const PLAN_PLUGIN = `export default {
  id: "myrel-plan",
  async setup(ctx) {
    let active = null;
    let planCalls = 0;
    let since = 0;
    const planCallsIn = (value, out) => {
      if (!value || typeof value !== "object") return out;
      if (Array.isArray(value)) {
        for (const item of value) planCallsIn(item, out);
        return out;
      }
      const name = value.tool ?? value.name ?? value.toolName ?? value.function?.name;
      // A call and its result both carry the tool's name; only the call carries its input.
      let args = name === "myrel_update_plan" ? value.state?.input ?? value.input ?? value.args ?? value.arguments ?? value.function?.arguments : undefined;
      if (args !== undefined) {
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = null;
          }
        }
        const steps = Array.isArray(args?.steps) ? args.steps : [];
        out.push(steps.find((s) => s && s.state === "active")?.text ?? null);
        return out;
      }
      for (const item of Object.values(value)) planCallsIn(item, out);
      return out;
    };
    await ctx.session.hook("context", (event) => {
      try {
        if (!Array.isArray(event.system)) return;
        const calls = planCallsIn(event.messages ?? [], []);
        if (calls.length !== planCalls) {
          planCalls = calls.length;
          since = 0;
          active = calls.at(-1) ?? null;
          return;
        }
        if (!active) return;
        since++;
        if (since % 3 !== 2) return;
        event.system.push({
          type: "text",
          text: '[Myrel] Your plan still shows "' + active + '" as the active step. If its work is done, call myrel_update_plan now to mark it done and the next step active, then go on. If not, carry on.',
        });
      } catch {
        // A reminder is never worth failing the run.
      }
    });
  },
};
`;

/** A base URL without its trailing slashes, so a path joins it with exactly one. */
function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

export function opencodeModel(spec: TaskSpec): string | null {
  const m = spec.model;
  if (!m) return null;
  return m.kind === "anthropic" ? `anthropic/${m.id}` : `${CUSTOM_PROVIDER}/${m.id}`;
}

export function opencodeConfig(spec: TaskSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    // Nobody is there to approve, so anything that asks is rejected: the sandbox is the boundary.
    // external_directory covers the folders next to the saved one (repos, files, skills).
    permissions: [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "webfetch", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ],
    // OpenCode 2 keeps its todo tools off unless asked; the harness shows them as the task's steps.
    experimental: { todo: true },
  };
  if (spec.mcp) {
    // The token is read from the environment so it never lands in the config. Code Mode stays off:
    // the run's tools stay tools of their own instead of calls inside one execute script.
    const auth = { Authorization: "Bearer {env:MYREL_MCP_TOKEN}" };
    const servers: Record<string, unknown> = { myrel: { type: "remote", url: spec.mcp.url, headers: auth, oauth: false, codemode: false } };
    for (const c of spec.mcp.connectors ?? []) {
      servers[c.name] =
        c.transport === "http"
          ? { type: "remote", url: c.url, headers: auth, oauth: false, codemode: false }
          : {
              type: "local",
              command: [c.command, ...c.args],
              environment: Object.fromEntries(Object.entries(c.env).map(([name, secret]) => [name, `{env:${secret}}`])),
              codemode: false,
            };
    }
    config.mcp = { servers };
    config.plugins = [{ package: PLAN_PLUGIN_DIR }];
  }
  const m = spec.model;
  if (!m) return config;
  const apiKey = "{env:MYREL_MODEL_API_KEY}";
  // Titles and summaries use the task's model too: Myrel's proxy lets only that one through.
  config.agents = { title: { model: opencodeModel(spec) } };
  config.providers =
    m.kind === "anthropic"
      ? { anthropic: { settings: { apiKey, ...(m.baseUrl ? { baseURL: `${trimSlashes(m.baseUrl)}/v1` } : {}) } } }
      : {
          [CUSTOM_PROVIDER]: {
            package: "@opencode/ai/providers/openai-compatible",
            name: `Myrel (${m.provider})`,
            env: ["MYREL_MODEL_API_KEY"],
            settings: { baseURL: m.baseUrl, apiKey },
            // OpenCode passes an image file it reads to the model only when the model says it takes images.
            models: {
              [m.id]: {
                name: m.id,
                capabilities: { tools: true, input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
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
