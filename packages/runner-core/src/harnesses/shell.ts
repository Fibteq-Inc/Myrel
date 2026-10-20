import { type Harness, log } from "../harness";

/** No model: the prompt is a bash script. Every output line is terminal output. */
export const shell: Harness = {
  id: "shell",
  label: "Shell",
  command: () => 'bash -c "$MYREL_PROMPT"',
  env: () => ({}),
  parse: (line) => [log(line)],
};
