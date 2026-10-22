# The sandbox every thread's agent works in (see src/sandbox/sandbox.ts). `wrangler deploy` builds it
# and pushes it to Cloudflare's registry, so containers start from it in seconds. Versions are pinned
# so the image is reproducible; the steps run from the slowest-changing to the fastest-changing, so a
# version bump rebuilds only the layers after it.
# Docker Hub's official Node image through Google's mirror, which Docker Hub's pull limits do not hit.
FROM mirror.gcr.io/library/node:24.22.1-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    bash ca-certificates curl git jq less openssh-client procps ripgrep unzip \
    build-essential python3 python3-pip python3-venv gh \
    poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Python libraries for the files people attach (PDF, Excel/CSV, Word, PowerPoint, images): reading
# them (MarkItDown turns any of them into Markdown) and making new ones. uv installs them several
# times faster than pip, and uvx starts Python MCP servers people connect. The sandbox is the
# boundary, so the system Python is fine (Debian marks it externally managed).
RUN pip3 install --break-system-packages --no-cache-dir "uv==0.12.24" \
  && uv pip install --system --break-system-packages --no-cache \
    "markitdown[pdf,docx,pptx,xlsx,xls]==0.1.3" \
    "pdfplumber==0.11.7" \
    "pypdf==6.1.1" \
    "pandas==2.3.3" \
    "openpyxl==3.1.5" \
    "xlsxwriter==3.2.9" \
    "python-docx==1.2.0" \
    "python-pptx==1.0.2" \
    "reportlab==4.4.4" \
    "pillow==11.3.0" \
    "matplotlib==3.10.7"

# The user the harness runs as (SANDBOX_USER in src/sandbox/setup.ts).
RUN useradd --create-home --shell /bin/bash myrel \
  && mkdir -p /workspace && chown myrel:myrel /workspace

ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare "pnpm@10.28.0" --activate && chmod -R a+rX "$COREPACK_HOME"

# The coding agent of cloud turns.
RUN npm install -g "opencode-ai@1.19.3" && npm cache clean --force

# Work arrives through exec; this only keeps the container up.
CMD ["sleep", "infinity"]
