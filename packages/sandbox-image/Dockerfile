# The Linux image every thread's sandbox runs (apps/api/src/sandbox). run_task executes
# @altair/runner's task script in it: git clone, the coding harness, then gh to open a PR.
# Wrangler builds it on deploy (apps/api/wrangler.jsonc, "containers").
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.19.3
ARG CLAUDE_CODE_VERSION=2.1.303
ARG PNPM_VERSION=10.28.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq less openssh-client procps ripgrep unzip \
    build-essential python3 python3-pip python3-venv \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/usr/local/share/corepack
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && chmod -R a+rX "$COREPACK_HOME" && npm cache clean --force

# Harnesses run as a normal user: Claude Code refuses to skip permissions as root.
RUN useradd --create-home --shell /bin/bash altair \
  && mkdir -p /workspace && chown altair:altair /workspace
USER altair
WORKDIR /workspace
ENV HOME=/home/altair CI=1 GIT_TERMINAL_PROMPT=0

# Work arrives through exec; the container itself only has to stay up.
CMD ["sleep", "infinity"]
