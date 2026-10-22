import type { Harness } from "./harness";
import type { TaskSpec } from "./spec";

/**
 * The bash script a runner executes for one task: prepare the workspace,
 * clone or update the repository, run the harness, save the result to the
 * thread's workspace remote when there is one, then commit, push and open a
 * pull request when asked. Progress goes to stdout as `::myrel::`
 * marker lines between the harness's own output (see lines.ts).
 *
 * Inputs come from the environment (`taskEnv` plus secrets) so nothing the
 * person or the model wrote is ever spliced into the script itself.
 * Secrets: GITHUB_TOKEN (clone and push; also read by `gh` as GH_TOKEN),
 * MYREL_WORKSPACE_TOKEN (the workspace remote), MYREL_MODEL_API_KEY and MYREL_FILES (download links of
 * the thread's attachments). Needs git, jq, curl and, to open pull requests, gh.
 */
export function taskScript(): string {
  return `set -uo pipefail
emit() { printf '::myrel::%s\\n' "$1"; }
phase() { emit "$(jq -cn --arg p "$1" --arg s "$2" --arg d "\${3:-}" '{type:"phase",phase:$p,state:$s} + (if $d == "" then {} else {detail:$d} end)')"; }
fail() { phase "$1" failed "$2"; exit "\${3:-1}"; }
note() { emit "$(jq -cn --arg t "$1" '{type:"log",stream:"system",text:$t}')"; }

phase prepare started
mkdir -p "$MYREL_WORKDIR" && cd "$MYREL_WORKDIR" || fail prepare "Cannot open $MYREL_WORKDIR"
git config --global user.name "$MYREL_GIT_NAME"
git config --global user.email "$MYREL_GIT_EMAIL"
git config --global init.defaultBranch main
# An older script set a helper for every host; a sandbox that ran one still has it.
git config --global --unset-all credential.helper >/dev/null 2>&1
if [ -n "\${MYREL_WORKSPACE_TOKEN:-}" ]; then
  # Sent only to the workspace remote, and kept in the environment rather than on disk.
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$MYREL_WORKSPACE_REMOTE.extraHeader"
  export GIT_CONFIG_VALUE_0="Authorization: Bearer $MYREL_WORKSPACE_TOKEN"
fi
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  # The token stays in the environment; git asks this helper instead of storing it. It is GitHub's
  # only: the helper is set for https://github.com and answers nothing for any other host (a
  # submodule or remote elsewhere asking for a password gets none).
  git config --global credential.https://github.com.helper '!f() { [ "$1" = get ] || exit 0; p=; h=; while IFS== read -r k v; do case "$k" in protocol) p="$v" ;; host) h="$v" ;; esac; done; [ "$p" = https ] && [ "$h" = github.com ] || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  export GH_TOKEN="$GITHUB_TOKEN"
fi
# There is no SSH key here: GitHub's SSH addresses go over HTTPS, where the token above works.
git config --global --replace-all url.https://github.com/.insteadOf git@github.com:
git config --global --add url.https://github.com/.insteadOf ssh://git@github.com/
phase prepare done

WS="\${MYREL_WORKSPACE_REMOTE:-}"
REPO_DIR=""
SAVED=0
# Fetches the branch this thread saved last time, if there is one. If the
# workspace cannot be reached, the task goes on without saving.
fetch_saved() {
  [ -n "$WS" ] || return 0
  git remote remove workspace >/dev/null 2>&1
  git remote add workspace "$WS"
  git ls-remote --exit-code workspace "refs/heads/$MYREL_BRANCH" >/dev/null 2>&1
  case $? in
    0) git fetch --quiet workspace "+refs/heads/$MYREL_BRANCH:refs/remotes/workspace/$MYREL_BRANCH" && SAVED=1 ;;
    2) return 0 ;;
  esac
  # Saving over work that could not be fetched would lose it.
  [ "$SAVED" = 1 ] || { note "Cannot reach this thread's workspace, so this task's work will not be saved there."; WS=""; }
}

if [ -n "\${MYREL_REPO_URL:-}" ]; then
  phase clone started
  REPO_DIR="$MYREL_WORKDIR/$(basename "$MYREL_REPO_URL" .git)"
  if [ -d "$REPO_DIR/.git" ]; then
    git -C "$REPO_DIR" fetch --quiet --prune origin || fail clone "git fetch failed"
  else
    git clone --quiet "$MYREL_REPO_URL" "$REPO_DIR" || fail clone "git clone failed"
  fi
  cd "$REPO_DIR"
  git remote set-head origin --auto >/dev/null 2>&1
  BASE="\${MYREL_BASE_BRANCH:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')}"
  BASE="\${BASE:-main}"
  # Leftovers from an earlier task in this sandbox are not this task's work.
  git reset --quiet --hard && git clean -qfd
  fetch_saved
  if [ "$SAVED" = 1 ] && { ! git rev-parse --verify --quiet "origin/$MYREL_BRANCH" >/dev/null ||
    git merge-base --is-ancestor "origin/$MYREL_BRANCH" "workspace/$MYREL_BRANCH"; }; then
    # The saved work is newer than what was pushed (or nothing was pushed yet).
    git checkout --quiet -B "$MYREL_BRANCH" "workspace/$MYREL_BRANCH" || fail clone "Cannot check out the saved work"
    note "Continuing from the work saved in this thread."
  elif git rev-parse --verify --quiet "origin/$MYREL_BRANCH" >/dev/null; then
    git checkout --quiet -B "$MYREL_BRANCH" "origin/$MYREL_BRANCH" || fail clone "Cannot check out $MYREL_BRANCH"
  else
    git checkout --quiet -B "$MYREL_BRANCH" "origin/$BASE" || fail clone "Cannot check out $BASE"
  fi
  phase clone done "$MYREL_BRANCH"
elif [ -n "$WS" ]; then
  # No repository: the thread's workspace is the repository.
  phase clone started
  REPO_DIR="$MYREL_WORKDIR/workspace"
  mkdir -p "$REPO_DIR" && cd "$REPO_DIR" || fail clone "Cannot open $REPO_DIR"
  [ -d .git ] || git init --quiet || fail clone "git init failed"
  git reset --quiet --hard >/dev/null 2>&1; git clean -qfd
  fetch_saved
  if [ "$SAVED" = 1 ]; then
    git checkout --quiet -B "$MYREL_BRANCH" "workspace/$MYREL_BRANCH" || fail clone "Cannot check out the saved work"
    note "Continuing from the work saved in this thread."
  elif git rev-parse --verify --quiet HEAD >/dev/null; then
    git checkout --quiet -B "$MYREL_BRANCH"
  else
    git symbolic-ref HEAD "refs/heads/$MYREL_BRANCH"
  fi
  phase clone done
else
  phase clone skipped
fi

# Files attached in the thread ([{path,url}] in MYREL_FILES), next to the saved folder rather than
# in it, so they are at hand without being saved with the work. An upload never changes, so one
# already here is kept.
if [ -n "\${MYREL_FILES:-}" ]; then
  FILES_DIR="$MYREL_WORKDIR/files"
  while IFS=$'\t' read -r FILE_PATH FILE_URL; do
    case "/$FILE_PATH/" in */../*|*/./*|//) continue ;; esac
    DEST="$FILES_DIR/$FILE_PATH"
    case "$FILE_PATH" in uploads/*) [ -s "$DEST" ] && continue ;; esac
    mkdir -p "$(dirname "$DEST")" && curl -fsSL --retry 2 -o "$DEST.part" "$FILE_URL" && mv -f "$DEST.part" "$DEST" ||
      { rm -f "$DEST.part"; note "Could not download $FILE_PATH; read_file gives a fresh link."; }
  done < <(printf '%s' "$MYREL_FILES" | jq -r '.[] | [.path, .url] | @tsv')
fi

# Skills people added in Myrel ({skills:[{name,files:[{path,content}]}]} at MYREL_SKILLS_URL, base64
# contents), next to the saved folder, and copied to where OpenCode and Claude Code look for their
# own. Last turn's are removed first, so a skill turned off is gone.
SKILLS_DIR="$MYREL_WORKDIR/skills"
rm -rf "$SKILLS_DIR"
if [ -n "\${MYREL_SKILLS_URL:-}" ]; then
  mkdir -p "$SKILLS_DIR"
  if curl -fsSL --retry 2 -H "Authorization: Bearer \${MYREL_MCP_TOKEN:-}" -o "$SKILLS_DIR/.bundle.json" "$MYREL_SKILLS_URL"; then
    while IFS=$'\t' read -r SKILL_FILE SKILL_CONTENT; do
      case "/$SKILL_FILE/" in */../*|*/./*|//) continue ;; esac
      mkdir -p "$SKILLS_DIR/$(dirname "$SKILL_FILE")" && printf '%s' "$SKILL_CONTENT" | base64 -d > "$SKILLS_DIR/$SKILL_FILE"
    done < <(jq -r '.skills[] | .name as $n | .files[] | [($n + "/" + .path), .content] | @tsv' "$SKILLS_DIR/.bundle.json")
    # Scripts keep working however their files were made.
    find "$SKILLS_DIR" -type f \\( -name '*.sh' -o -name '*.py' -o -path '*/scripts/*' \\) -exec chmod +x {} + 2>/dev/null
  else
    note "Could not download this turn's skills."
  fi
  rm -f "$SKILLS_DIR/.bundle.json"
fi
# Only the skills this script put there (listed in .myrel-skills) are replaced; others are left alone.
for OWN in "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills" "$HOME/.claude/skills"; do
  if [ -f "$OWN/.myrel-skills" ]; then
    while IFS= read -r SKILL_NAME; do [ -n "$SKILL_NAME" ] && rm -rf "\${OWN:?}/$SKILL_NAME"; done < "$OWN/.myrel-skills"
    rm -f "$OWN/.myrel-skills"
  fi
  [ -d "$SKILLS_DIR" ] || continue
  mkdir -p "$OWN"
  for SKILL_PATH in "$SKILLS_DIR"/*/; do
    [ -d "$SKILL_PATH" ] || continue
    SKILL_NAME="$(basename "$SKILL_PATH")"
    rm -rf "\${OWN:?}/$SKILL_NAME" && cp -R "$SKILL_PATH" "$OWN/$SKILL_NAME" && echo "$SKILL_NAME" >> "$OWN/.myrel-skills"
  done
done

phase agent started
# The harness runs in its own process group, recorded in HARNESS_PID_FILE, so the runner can end a
# turn that is done (its reply sent, its plan finished) when the harness does not exit by itself:
# it creates HARNESS_DONE_FILE and stops the group, and the work is saved as finished.
HARNESS_PID_FILE=/tmp/myrel-harness.pid
HARNESS_DONE_FILE=/tmp/myrel-harness.done
rm -f "$HARNESS_DONE_FILE"
if command -v setsid >/dev/null 2>&1; then setsid bash -c "$MYREL_HARNESS_COMMAND" & else bash -c "$MYREL_HARNESS_COMMAND" & fi
echo "$!" > "$HARNESS_PID_FILE"
wait "$!"
CODE=$?
if [ -e "$HARNESS_DONE_FILE" ]; then
  CODE=0
  note "Ended $MYREL_HARNESS_LABEL: its reply was sent and its plan is done."
fi
rm -f "$HARNESS_PID_FILE" "$HARNESS_DONE_FILE"
if [ "$CODE" -eq 0 ]; then phase agent done; else phase agent failed "$MYREL_HARNESS_LABEL exited with code $CODE"; fi

# The repositories the harness cloned keep its work on GitHub: whatever it left uncommitted or
# unpushed becomes one commit on top of where it was, pushed to MYREL_SAVE_BRANCH. Its own branches
# and index stay as they were.
save_repo() {
  local dir="$1" name head tree idx branch commit
  name="$(basename "$dir")"
  git -C "$dir" config --get remote.origin.url | grep -q 'github\.com' || return 0
  head="$(git -C "$dir" rev-parse --verify --quiet HEAD)" || return 0
  idx="$(mktemp)"
  cp "$dir/.git/index" "$idx" 2>/dev/null
  tree="$(GIT_INDEX_FILE="$idx" git -C "$dir" add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git -C "$dir" write-tree)"
  rm -f "$idx"
  [ -n "$tree" ] || { note "Could not save the work in $name."; return 0; }
  if [ "$tree" = "$(git -C "$dir" rev-parse "HEAD^{tree}")" ] && [ -n "$(git -C "$dir" branch -r --contains HEAD 2>/dev/null)" ]; then
    return 0
  fi
  branch="$(git -C "$dir" symbolic-ref --short -q HEAD || echo "a detached HEAD")"
  commit="$(git -C "$dir" commit-tree "$tree" -p "$head" -m "Unsaved work on $branch, saved by Myrel")" || { note "Could not save the work in $name."; return 0; }
  if git -C "$dir" push --quiet --force origin "$commit:refs/heads/$MYREL_SAVE_BRANCH" 2>/dev/null; then
    note "Saved the unpushed work in $name to its branch $MYREL_SAVE_BRANCH on GitHub."
  else
    note "Could not push the unpushed work in $name to GitHub, so it is lost when the sandbox stops."
  fi
}
if [ -n "\${MYREL_SAVE_BRANCH:-}" ] && [ -d "\${MYREL_SAVE_REPOS_DIR:-}" ]; then
  for SAVE_DIR in "$MYREL_SAVE_REPOS_DIR"/*/; do
    [ -d "$SAVE_DIR/.git" ] && save_repo "\${SAVE_DIR%/}"
  done
fi

# Every result is saved, unfinished work too, so the next task can pick it up.
if [ -n "$WS" ] && [ -n "$REPO_DIR" ]; then
  phase save started
  cd "$REPO_DIR"
  MSG="$MYREL_TITLE"
  [ "$CODE" -eq 0 ] || MSG="$MSG (unfinished)"
  git add -A
  if ! { git diff --cached --quiet || git commit --quiet -m "$MSG"; }; then
    phase save failed "git commit failed"
  elif ! git rev-parse --verify --quiet HEAD >/dev/null; then
    phase save skipped "Nothing to save"
  elif git push --quiet --force workspace "HEAD:refs/heads/$MYREL_BRANCH"; then
    phase save done "$(git rev-parse --short HEAD)"
  else
    phase save failed "git push failed"
  fi
fi
[ "$CODE" -eq 0 ] || exit "$CODE"

if [ "\${MYREL_OPEN_PR:-0}" = "1" ] && [ -n "\${MYREL_REPO_URL:-}" ]; then
  phase publish started
  git add -A
  git diff --cached --quiet || git commit --quiet -m "$MYREL_TITLE" || fail publish "git commit failed"
  if [ "$(git rev-list --count "origin/$BASE..HEAD")" -eq 0 ]; then
    phase publish skipped "No changes to publish"
    exit 0
  fi
  git push --quiet -u origin "HEAD:refs/heads/$MYREL_BRANCH" || fail publish "git push failed"
  URL="$(gh pr view "$MYREL_BRANCH" --json url -q .url 2>/dev/null)"
  if [ -z "$URL" ]; then
    URL="$(gh pr create --head "$MYREL_BRANCH" --base "$BASE" --title "$MYREL_TITLE" --body "$MYREL_PR_BODY" | tail -n 1)" || fail publish "gh pr create failed"
  fi
  emit "$(jq -cn --arg u "$URL" '{type:"pr",url:$u}')"
  phase publish done
else
  phase publish skipped
fi
`;
}

/**
 * Run next to a task's script: ends its harness as finished (see the agent phase of `taskScript`).
 * Exits non-zero when no harness is running.
 */
export const STOP_HARNESS_SCRIPT = `PID=$(cat /tmp/myrel-harness.pid 2>/dev/null) || exit 1
touch /tmp/myrel-harness.done
kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID"
# A harness that ignores the request is stopped for good shortly after.
(sleep 10; kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID") >/dev/null 2>&1 &`;

/** Non-secret environment for `taskScript`. */
export function taskEnv(
  spec: TaskSpec,
  harness: Harness,
  opts: { workdir?: string; gitName?: string; gitEmail?: string } = {},
): Record<string, string> {
  return {
    ...harness.env(spec),
    MYREL_TASK_ID: spec.taskId,
    MYREL_TITLE: spec.title,
    MYREL_PROMPT: spec.prompt,
    MYREL_HARNESS_COMMAND: harness.command(spec),
    MYREL_HARNESS_LABEL: harness.label,
    MYREL_WORKDIR: opts.workdir ?? "/workspace",
    MYREL_GIT_NAME: opts.gitName ?? "Myrel",
    MYREL_GIT_EMAIL: opts.gitEmail ?? "myrel@users.noreply.github.com",
    MYREL_REPO_URL: spec.repo?.url ?? "",
    MYREL_BASE_BRANCH: spec.repo?.baseBranch ?? "",
    MYREL_WORKSPACE_REMOTE: spec.workspace?.remote ?? "",
    MYREL_BRANCH: workingBranch(spec),
    MYREL_OPEN_PR: spec.openPr ? "1" : "0",
    MYREL_SKILLS_URL: spec.skills?.url ?? "",
    MYREL_SAVE_REPOS_DIR: spec.saveRepos?.dir ?? "",
    MYREL_SAVE_BRANCH: spec.saveRepos?.branch ?? "",
    MYREL_PR_BODY: `${spec.prompt.slice(0, 4000)}\n\n---\n_Opened by Myrel._`,
  };
}

/** The branch a task works on, and saves to in the thread's workspace. */
export function workingBranch(spec: Pick<TaskSpec, "taskId" | "title" | "repo">): string {
  // Without a repository, every task in the thread continues the same line of work.
  return spec.repo ? spec.repo.branch || taskBranch(spec) : "main";
}

/** Default working branch for a task, e.g. `myrel/fix-login-bug-x7k2pq`. */
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
  return `myrel/${slug ? `${slug}-` : ""}${suffix}`;
}
