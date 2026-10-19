import type { Harness } from "./harness";
import type { TaskSpec } from "./spec";

/**
 * The bash script a runner executes for one task: prepare the workspace,
 * clone or update the repository, run the harness, then commit, push and
 * open a pull request when asked. Progress goes to stdout as `::altair::`
 * marker lines between the harness's own output (see lines.ts).
 *
 * Inputs come from the environment (`taskEnv` plus secrets) so nothing the
 * person or the model wrote is ever spliced into the script itself.
 * Secrets: GITHUB_TOKEN (clone and push; also read by `gh` as GH_TOKEN) and
 * ALTAIR_MODEL_API_KEY. Needs git, jq and, to open pull requests, gh.
 */
export function taskScript(): string {
  return `set -uo pipefail
emit() { printf '::altair::%s\\n' "$1"; }
phase() { emit "$(jq -cn --arg p "$1" --arg s "$2" --arg d "\${3:-}" '{type:"phase",phase:$p,state:$s} + (if $d == "" then {} else {detail:$d} end)')"; }
fail() { phase "$1" failed "$2"; exit "\${3:-1}"; }

phase prepare started
mkdir -p "$ALTAIR_WORKDIR" && cd "$ALTAIR_WORKDIR" || fail prepare "Cannot open $ALTAIR_WORKDIR"
git config --global user.name "$ALTAIR_GIT_NAME"
git config --global user.email "$ALTAIR_GIT_EMAIL"
git config --global init.defaultBranch main
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  # The token stays in the environment; git asks this helper instead of storing it.
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  export GH_TOKEN="$GITHUB_TOKEN"
fi
phase prepare done

if [ -n "\${ALTAIR_REPO_URL:-}" ]; then
  phase clone started
  REPO_DIR="$ALTAIR_WORKDIR/$(basename "$ALTAIR_REPO_URL" .git)"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" fetch --quiet --prune origin || fail clone "git fetch failed"
  else
    git clone --quiet "$ALTAIR_REPO_URL" "$REPO_DIR" || fail clone "git clone failed"
  fi
  cd "$REPO_DIR"
  git remote set-head origin --auto >/dev/null 2>&1
  BASE="\${ALTAIR_BASE_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')}"
  BASE="\${BASE:-main}"
  # Leftovers from an earlier task in this sandbox are not this task's work.
  git reset --quiet --hard && git clean -qfd
  if git rev-parse --verify --quiet "origin/$ALTAIR_BRANCH" >/dev/null; then
    git checkout --quiet -B "$ALTAIR_BRANCH" "origin/$ALTAIR_BRANCH" || fail clone "Cannot check out $ALTAIR_BRANCH"
  else
    git checkout --quiet -B "$ALTAIR_BRANCH" "origin/$BASE" || fail clone "Cannot check out $BASE"
  fi
  phase clone done "$ALTAIR_BRANCH"
else
  phase clone skipped
fi

phase agent started
eval "$ALTAIR_HARNESS_COMMAND"
CODE=$?
[ "$CODE" -eq 0 ] || fail agent "$ALTAIR_HARNESS_LABEL exited with code $CODE" "$CODE"
phase agent done

if [ "\${ALTAIR_OPEN_PR:-0}" = "1" ] && [ -n "\${ALTAIR_REPO_URL:-}" ]; then
  phase publish started
  git add -A
  git diff --cached --quiet || git commit --quiet -m "$ALTAIR_TITLE" || fail publish "git commit failed"
  if [ "$(git rev-list --count "origin/$BASE..HEAD")" -eq 0 ]; then
    phase publish skipped "No changes to publish"
    exit 0
  fi
  git push --quiet -u origin "HEAD:refs/heads/$ALTAIR_BRANCH" || fail publish "git push failed"
  URL="$(gh pr view "$ALTAIR_BRANCH" --json url -q .url 2>/dev/null)"
  if [ -z "$URL" ]; then
    URL="$(gh pr create --head "$ALTAIR_BRANCH" --base "$BASE" --title "$ALTAIR_TITLE" --body "$ALTAIR_PR_BODY" | tail -n 1)" || fail publish "gh pr create failed"
  fi
  emit "$(jq -cn --arg u "$URL" '{type:"pr",url:$u}')"
  phase publish done
else
  phase publish skipped
fi
`;
}

/** Non-secret environment for `taskScript`. */
export function taskEnv(
  spec: TaskSpec,
  harness: Harness,
  opts: { workdir?: string; gitName?: string; gitEmail?: string } = {},
): Record<string, string> {
  return {
    ...harness.env(spec),
    ALTAIR_TASK_ID: spec.taskId,
    ALTAIR_TITLE: spec.title,
    ALTAIR_PROMPT: spec.prompt,
    ALTAIR_HARNESS_COMMAND: harness.command(spec),
    ALTAIR_HARNESS_LABEL: harness.label,
    ALTAIR_WORKDIR: opts.workdir ?? "/workspace",
    ALTAIR_GIT_NAME: opts.gitName ?? "Altair",
    ALTAIR_GIT_EMAIL: opts.gitEmail ?? "altair@users.noreply.github.com",
    ALTAIR_REPO_URL: spec.repo?.url ?? "",
    ALTAIR_BASE_BRANCH: spec.repo?.baseBranch ?? "",
    ALTAIR_BRANCH: spec.repo?.branch || taskBranch(spec),
    ALTAIR_OPEN_PR: spec.openPr ? "1" : "0",
    ALTAIR_PR_BODY: `${spec.prompt.slice(0, 4000)}\n\n---\n_Opened by Altair._`,
  };
}

/** Default working branch for a task, e.g. `altair/fix-login-bug-x7k2pq`. */
export function taskBranch(spec: Pick<TaskSpec, "taskId" | "title">): string {
  const slug = spec.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const suffix = spec.taskId.slice(-6).toLowerCase();
  return `altair/${slug ? `${slug}-` : ""}${suffix}`;
}
