import type { Harness } from "./harness";
import type { TaskSpec } from "./spec";

/**
 * The bash script a runner executes for one task: prepare the workspace,
 * clone or update the repository, run the harness, save the result to the
 * thread's workspace remote when there is one, then commit, push and open a
 * pull request when asked. Progress goes to stdout as `::altair::`
 * marker lines between the harness's own output (see lines.ts).
 *
 * Inputs come from the environment (`taskEnv` plus secrets) so nothing the
 * person or the model wrote is ever spliced into the script itself.
 * Secrets: GITHUB_TOKEN (clone and push; also read by `gh` as GH_TOKEN),
 * ALTAIR_WORKSPACE_TOKEN (the workspace remote) and ALTAIR_MODEL_API_KEY. Needs git, jq and, to open pull requests, gh.
 */
export function taskScript(): string {
  return `set -uo pipefail
emit() { printf '::altair::%s\\n' "$1"; }
phase() { emit "$(jq -cn --arg p "$1" --arg s "$2" --arg d "\${3:-}" '{type:"phase",phase:$p,state:$s} + (if $d == "" then {} else {detail:$d} end)')"; }
fail() { phase "$1" failed "$2"; exit "\${3:-1}"; }
note() { emit "$(jq -cn --arg t "$1" '{type:"log",stream:"system",text:$t}')"; }

phase prepare started
mkdir -p "$ALTAIR_WORKDIR" && cd "$ALTAIR_WORKDIR" || fail prepare "Cannot open $ALTAIR_WORKDIR"
git config --global user.name "$ALTAIR_GIT_NAME"
git config --global user.email "$ALTAIR_GIT_EMAIL"
git config --global init.defaultBranch main
if [ -n "\${ALTAIR_WORKSPACE_TOKEN:-}" ]; then
  # Sent only to the workspace remote, and kept in the environment rather than on disk.
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$ALTAIR_WORKSPACE_REMOTE.extraHeader"
  export GIT_CONFIG_VALUE_0="Authorization: Bearer $ALTAIR_WORKSPACE_TOKEN"
fi
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  # The token stays in the environment; git asks this helper instead of storing it.
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  export GH_TOKEN="$GITHUB_TOKEN"
fi
phase prepare done

WS="\${ALTAIR_WORKSPACE_REMOTE:-}"
REPO_DIR=""
SAVED=0
# Fetches the branch this thread saved last time, if there is one. If the
# workspace cannot be reached, the task goes on without saving.
fetch_saved() {
  [ -n "$WS" ] || return 0
  git remote remove workspace >/dev/null 2>&1
  git remote add workspace "$WS"
  git ls-remote --exit-code workspace "refs/heads/$ALTAIR_BRANCH" >/dev/null 2>&1
  case $? in
    0) git fetch --quiet workspace "+refs/heads/$ALTAIR_BRANCH:refs/remotes/workspace/$ALTAIR_BRANCH" && SAVED=1 ;;
    2) return 0 ;;
  esac
  # Saving over work that could not be fetched would lose it.
  [ "$SAVED" = 1 ] || { note "Cannot reach this thread's workspace, so this task's work will not be saved there."; WS=""; }
}

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
  fetch_saved
  if [ "$SAVED" = 1 ] && { ! git rev-parse --verify --quiet "origin/$ALTAIR_BRANCH" >/dev/null ||
    git merge-base --is-ancestor "origin/$ALTAIR_BRANCH" "workspace/$ALTAIR_BRANCH"; }; then
    # The saved work is newer than what was pushed (or nothing was pushed yet).
    git checkout --quiet -B "$ALTAIR_BRANCH" "workspace/$ALTAIR_BRANCH" || fail clone "Cannot check out the saved work"
    note "Continuing from the work saved in this thread."
  elif git rev-parse --verify --quiet "origin/$ALTAIR_BRANCH" >/dev/null; then
    git checkout --quiet -B "$ALTAIR_BRANCH" "origin/$ALTAIR_BRANCH" || fail clone "Cannot check out $ALTAIR_BRANCH"
  else
    git checkout --quiet -B "$ALTAIR_BRANCH" "origin/$BASE" || fail clone "Cannot check out $BASE"
  fi
  phase clone done "$ALTAIR_BRANCH"
elif [ -n "$WS" ]; then
  # No repository: the thread's workspace is the repository.
  phase clone started
  REPO_DIR="$ALTAIR_WORKDIR/workspace"
  mkdir -p "$REPO_DIR" && cd "$REPO_DIR" || fail clone "Cannot open $REPO_DIR"
  [ -d .git ] || git init --quiet || fail clone "git init failed"
  git reset --quiet --hard >/dev/null 2>&1; git clean -qfd
  fetch_saved
  if [ "$SAVED" = 1 ]; then
    git checkout --quiet -B "$ALTAIR_BRANCH" "workspace/$ALTAIR_BRANCH" || fail clone "Cannot check out the saved work"
    note "Continuing from the work saved in this thread."
  elif git rev-parse --verify --quiet HEAD >/dev/null; then
    git checkout --quiet -B "$ALTAIR_BRANCH"
  else
    git symbolic-ref HEAD "refs/heads/$ALTAIR_BRANCH"
  fi
  phase clone done
else
  phase clone skipped
fi

phase agent started
eval "$ALTAIR_HARNESS_COMMAND"
CODE=$?
if [ "$CODE" -eq 0 ]; then phase agent done; else phase agent failed "$ALTAIR_HARNESS_LABEL exited with code $CODE"; fi

# Every result is saved, unfinished work too, so the next task can pick it up.
if [ -n "$WS" ] && [ -n "$REPO_DIR" ]; then
  phase save started
  cd "$REPO_DIR"
  MSG="$ALTAIR_TITLE"
  [ "$CODE" -eq 0 ] || MSG="$MSG (unfinished)"
  git add -A
  if ! { git diff --cached --quiet || git commit --quiet -m "$MSG"; }; then
    phase save failed "git commit failed"
  elif ! git rev-parse --verify --quiet HEAD >/dev/null; then
    phase save skipped "Nothing to save"
  elif git push --quiet --force workspace "HEAD:refs/heads/$ALTAIR_BRANCH"; then
    phase save done "$(git rev-parse --short HEAD)"
  else
    phase save failed "git push failed"
  fi
fi
[ "$CODE" -eq 0 ] || exit "$CODE"

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
    ALTAIR_WORKSPACE_REMOTE: spec.workspace?.remote ?? "",
    ALTAIR_BRANCH: workingBranch(spec),
    ALTAIR_OPEN_PR: spec.openPr ? "1" : "0",
    ALTAIR_PR_BODY: `${spec.prompt.slice(0, 4000)}\n\n---\n_Opened by Altair._`,
  };
}

/** The branch a task works on, and saves to in the thread's workspace. */
export function workingBranch(spec: Pick<TaskSpec, "taskId" | "title" | "repo">): string {
  // Without a repository, every task in the thread continues the same line of work.
  return spec.repo ? spec.repo.branch || taskBranch(spec) : "main";
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
