/** `/bin/zsh -lc <script>`, `bash -c <script>` and the like, as coding CLIs report their commands. */
const SHELL_WRAPPER = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(\S[\s\S]*)$/;

/**
 * The command a shell wrapper runs, so `/bin/zsh -lc "rg -g '"'!obj'"'"` reads as
 * `rg -g '!obj'`. Anything that is not one wrapper around one quoted (or plain) word comes back
 * unchanged.
 */
export function unwrapShell(command: string): string {
  const match = SHELL_WRAPPER.exec(command.trim());
  if (!match) return command;
  return shellWord(match[1]!) ?? command;
}

/** The value of one POSIX shell word made of quoted and plain parts, or null when it is not one word. */
function shellWord(word: string): string | null {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      if (end < 0) return null;
      out += word.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= word.length) return null;
        const d = word[i]!;
        if (d === '"') break;
        // Inside double quotes a backslash escapes only these.
        if (d === "\\" && i + 1 < word.length && '"\\$`\n'.includes(word[i + 1]!)) {
          out += word[i + 1];
          i += 2;
        } else {
          out += d;
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (i + 1 >= word.length) return null;
      out += word[i + 1];
      i += 2;
    } else if (/\s/.test(c) || "|&;<>()$`".includes(c)) {
      // A second word, an operator or an expansion: not a plain wrapper.
      return null;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
