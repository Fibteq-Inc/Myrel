/**
 * The scripts a cloud task runs through in its container (see sandbox.ts). Kept apart from the
 * Durable Object, which the tests here cannot run with a container; try them by hand in the
 * sandbox image (start a run, cut its follow off, follow again from the line it got to).
 */

/** Values shorter than this are left alone: they would match ordinary output. */
export const MIN_SCRUBBED = 12;

/** Where a task's detached run keeps its process id, output and exit code in the container. */
const RUN_DIR = "/tmp/myrel-task";

/**
 * Starts the task script on its own, outside the exec that starts it: a deploy restarts this
 * Durable Object and drops every exec it had open, but the container and what runs in it go on.
 * Its output goes to a file, with the run's secrets hidden on the way (see SCRUB_JS), and its exit
 * code to another once it ends.
 */
export const START_SCRIPT = `set -u
rm -rf ${RUN_DIR} && mkdir -p ${RUN_DIR} || exit 1
setsid bash -c 'bash -c "$MYREL_TASK_SCRIPT" 2>&1 | node -e "$MYREL_SCRUB_JS" > ${RUN_DIR}/out; echo "\${PIPESTATUS[0]}" > ${RUN_DIR}/exit.part && mv ${RUN_DIR}/exit.part ${RUN_DIR}/exit' </dev/null >/dev/null 2>&1 &
echo "$!" > ${RUN_DIR}/pid`;

/**
 * Prints the run's output from line MYREL_FROM + 1 on, as it is written, until the run ends, then
 * MYREL_EXIT_MARKER and its exit code (none when it was killed before writing one).
 */
export const FOLLOW_SCRIPT = `PID=$(cat ${RUN_DIR}/pid 2>/dev/null) || { echo "$MYREL_EXIT_MARKER"; exit 0; }
tail -n "+$((MYREL_FROM + 1))" --pid="$PID" -F ${RUN_DIR}/out 2>/dev/null
echo "$MYREL_EXIT_MARKER$(cat ${RUN_DIR}/exit 2>/dev/null)"`;

/** Succeeds while the run is still going or has ended with its exit code written. */
export const PROBE_SCRIPT = `PID=$(cat ${RUN_DIR}/pid 2>/dev/null) && { kill -0 "$PID" 2>/dev/null || test -e ${RUN_DIR}/exit; }`;

/** Stops the run: the task script and the harness it started in its own process group. */
export const KILL_SCRIPT = `for F in ${RUN_DIR}/pid /tmp/myrel-harness.pid; do
  PID=$(cat "$F" 2>/dev/null) || continue
  kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
  (sleep 10; kill -KILL -- "-$PID" 2>/dev/null) >/dev/null 2>&1 &
done
exit 0`;

/**
 * Node filter between the task script and its output file: replaces the values of the variables
 * named in MYREL_SCRUB_NAMES, line by line, the same way as `secretScrubber`.
 */
export const SCRUB_JS = `const env = process.env;
const values = (env.MYREL_SCRUB_NAMES || "").split(",").map((n) => env[n] || "").filter((v) => v.length >= ${MIN_SCRUBBED}).sort((a, b) => b.length - a.length);
const scrub = (t) => values.reduce((out, v) => (out.includes(v) ? out.split(v).join("[hidden]") : out), t);
let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  const end = rest.lastIndexOf("\\n");
  if (end < 0) return;
  process.stdout.write(scrub(rest.slice(0, end + 1)));
  rest = rest.slice(end + 1);
});
process.stdin.on("end", () => rest && process.stdout.write(scrub(rest)));`;

