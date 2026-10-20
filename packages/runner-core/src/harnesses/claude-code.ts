import { type Harness, jsonLine, log, num, obj, shellQuote, str, todoStatus } from "../harness";
import type { RunnerEvent } from "../spec";

/**
 * Claude Code (`claude -p --output-format stream-json`). Claude models only.
 * In the cloud it uses ANTHROPIC_API_KEY; the local runner uses the person's
 * own signed-in CLI, so their subscription never leaves their machine.
 */
export const claudeCode: Harness = {
  id: "claude-code",
  label: "Claude Code",

  command(spec) {
    const model = spec.model?.kind === "anthropic" ? `--model ${shellQuote(spec.model.id)}` : "";
    return [
      "claude -p --output-format stream-json --verbose --dangerously-skip-permissions",
      model,
      '"$MYREL_PROMPT"',
    ]
      .filter(Boolean)
      .join(" ");
  },

  env(spec) {
    // Only when the task carries a model: otherwise the local CLI's own login is used.
    if (spec.model?.kind !== "anthropic") return {};
    return { ...(spec.model.baseUrl ? { ANTHROPIC_BASE_URL: spec.model.baseUrl } : {}) };
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
