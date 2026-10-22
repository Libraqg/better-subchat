#!/bin/sh
# Pre-release checks: validate, core purity, type-check (when Node is present), tests.
set -eu
cd "$(dirname "$0")/.."

claude plugin validate .

if grep -rnE "from ['\"]claude-code" core; then
  echo "core/ must not import claude-code" >&2
  exit 1
fi
echo "core/ is free of claude-code imports"

if command -v npx >/dev/null 2>&1; then
  npx -y -p typescript@5 tsc -p core
  npx -y -p typescript@5 tsc -p .
else
  echo "skipped tsc: Node is not installed" >&2
fi

claude plugin test .
