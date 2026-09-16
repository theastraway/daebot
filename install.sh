#!/usr/bin/env bash
# MINDClaw — one-line installer.
#
# Usage:
#   curl -fsSL https://www.m-i-n-d.ai/install/mindclaw.sh | bash
#
# Installs:
#   1. The `mindclaw` global CLI (via npm).
#   2. The upstream `openclaw` runtime (via npm) on first run.
#   3. The @astramindapp/openclaw-mind plugin (via openclaw plugins install).
# Then runs the first-time onboarding wizard.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "MINDClaw needs Node.js 18+. Install from https://nodejs.org and re-run." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "MINDClaw needs Node.js 18+. You have $(node -v)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required and was not found on PATH." >&2
  exit 1
fi

echo "› Installing mindclaw globally..."
npm install --global @astramindapp/mind-claw

echo "› Launching first-run wizard..."
exec mindclaw init
