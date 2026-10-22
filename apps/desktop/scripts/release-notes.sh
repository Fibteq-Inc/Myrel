#!/usr/bin/env bash
# Prints release notes for a desktop tag: every pull request merged into main since the previous desktop
# tag that changed what ships in the app (the desktop shell, the web UI it wraps, the bundled runner and the
# shared packages). Pull request titles are used as they are, so the notes don't depend on Conventional
# Commits; CI, docs and chore changes are left out.
#
# Usage: release-notes.sh desktop-v0.2.0   (needs full history and tags)
set -euo pipefail

tag="$1"
repo_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Fibteq-Inc/myrel}"
paths=(apps/desktop apps/web packages/client packages/i18n packages/protocol packages/myrel-runner packages/runner-core)

prev="$(git describe --tags --abbrev=0 --match 'desktop-v*' "$tag^" 2>/dev/null || true)"
range="${prev:+$prev..}$tag"

features=()
fixes=()
other=()
for sha in $(git log --first-parent --reverse --format=%H "$range" -- "${paths[@]}"); do
  subject="$(git log -1 --format=%s "$sha")"
  body="$(git log -1 --format=%b "$sha" | sed -n '/[^[:space:]]/{p;q;}')"
  pr=""
  if [[ "$subject" =~ ^Merge\ pull\ request\ \#([0-9]+) ]]; then
    pr="${BASH_REMATCH[1]}"
    title="$body"
  elif [[ "$subject" =~ ^Merge\  ]]; then
    continue
  else
    title="$subject"
    if [[ "$title" =~ \ \(\#([0-9]+)\)$ ]]; then
      pr="${BASH_REMATCH[1]}"
      title="${title% (#*}"
    fi
  fi
  [ -n "$title" ] || continue
  # Release PRs and changes that don't reach users.
  [[ "$title" =~ ^(ci|chore|build|docs|test|style)(\(.*\))?!?: ]] && continue
  line="- ${title}${pr:+ ([#$pr]($repo_url/pull/$pr))}"
  if [[ "$title" =~ ^feat(\(.*\))?!?: ]]; then
    features+=("$line")
  elif [[ "$title" =~ ^fix(\(.*\))?!?: ]]; then
    fixes+=("$line")
  else
    other+=("$line")
  fi
done

if [ -n "$prev" ]; then
  echo "Changes since ${prev} ([full diff]($repo_url/compare/$prev...$tag))."
else
  echo "First release."
fi
section() {
  local heading="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  printf '\n### %s\n\n' "$heading"
  printf '%s\n' "$@"
}
section "Features" "${features[@]+"${features[@]}"}"
section "Fixes" "${fixes[@]+"${fixes[@]}"}"
section "Changes" "${other[@]+"${other[@]}"}"
