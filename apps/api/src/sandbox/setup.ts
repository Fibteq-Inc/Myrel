/**
 * What a sandbox needs on top of Cloudflare's managed `cloudflare/debian-trixie` image (Node.js on
 * Debian slim), so no image is built or pushed on deploy. The base Sandbox runs this once, snapshots
 * the result and every thread's container starts from that snapshot (see sandbox.ts).
 */

/** Cloudflare-managed image for the durable_object scheduling policy. */
export const BASE_IMAGE = "cloudflare/debian-trixie";

const OPENCODE_VERSION = "1.19.3";
const CLAUDE_CODE_VERSION = "2.1.303";
const PNPM_VERSION = "10.28.0";

/**
 * Python libraries for the files people attach (PDF, Excel/CSV, Word, PowerPoint, images): reading
 * them (MarkItDown turns any of them into Markdown) and making new ones. Pinned so the snapshot is
 * reproducible; changing one rebuilds it.
 */
const PYTHON_PACKAGES = [
  "markitdown[pdf,docx,pptx,xlsx,xls]==0.1.3",
  "pdfplumber==0.11.7",
  "pypdf==6.1.1",
  "pandas==2.3.3",
  "openpyxl==3.1.5",
  "xlsxwriter==3.2.9",
  "python-docx==1.2.0",
  "python-pptx==1.0.2",
  "reportlab==4.4.4",
  "pillow==11.3.0",
  "matplotlib==3.10.7",
];

/** The user harnesses run as: Claude Code refuses to skip permissions as root. */
export const SANDBOX_USER = "myrel";
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;

/** Runs as root in a fresh container. Exits non-zero on any failure. */
export const SETUP_SCRIPT = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=5 update
apt-get -o Acquire::Retries=5 install -y --no-install-recommends \\
  bash ca-certificates curl git jq less openssh-client procps ripgrep unzip \\
  build-essential python3 python3-pip python3-venv gh \\
  poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-tur fonts-dejavu-core
rm -rf /var/lib/apt/lists/*
# The sandbox is the boundary, so the system Python is fine (Debian marks it externally managed).
pip3 install --break-system-packages --no-cache-dir ${PYTHON_PACKAGES.map((p) => `"${p}"`).join(" ")}
export COREPACK_HOME=/usr/local/share/corepack
npm install -g "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
chmod -R a+rX "$COREPACK_HOME"
npm cache clean --force
id ${SANDBOX_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${SANDBOX_USER}
mkdir -p /workspace && chown ${SANDBOX_USER}:${SANDBOX_USER} /workspace
`;

/** Changes whenever the image or the setup changes, so a stale base snapshot is rebuilt. */
export const SETUP_VERSION = `${BASE_IMAGE}:${hash(SETUP_SCRIPT)}`;

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}
