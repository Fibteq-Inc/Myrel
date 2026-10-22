import { describe, expect, it } from "vitest";
import { unwrapShell } from "../src/shell";

describe("unwrapShell", () => {
  it("unwraps the commands Codex reports", () => {
    expect(unwrapShell("/bin/zsh -lc pwd")).toBe("pwd");
    expect(unwrapShell("/bin/zsh -lc 'ls -la'")).toBe("ls -la");
    expect(unwrapShell(`/bin/bash -lc "rg --files -g AGENTS.md -g '"'!node_modules'"' -g '"'!obj'"'"`)).toBe(
      "rg --files -g AGENTS.md -g '!node_modules' -g '!obj'",
    );
    expect(unwrapShell(`bash -c "echo \\"hi\\" \\$HOME"`)).toBe('echo "hi" $HOME');
  });

  it("leaves anything else as it is", () => {
    expect(unwrapShell("npm test")).toBe("npm test");
    expect(unwrapShell("/bin/zsh -lc 'ls' && pwd")).toBe("/bin/zsh -lc 'ls' && pwd");
    expect(unwrapShell("/bin/zsh -lc 'unterminated")).toBe("/bin/zsh -lc 'unterminated");
    expect(unwrapShell("/bin/zsh -lc $CMD")).toBe("/bin/zsh -lc $CMD");
  });
});
