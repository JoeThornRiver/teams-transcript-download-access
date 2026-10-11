#!/usr/bin/env bash

set -euo pipefail

required_files=(
  ".github/workflows/baseline.yml"
  ".gitignore"
  ".markdownlint.json"
  "AGENTS.md"
  "CONTRIBUTING.md"
  "LICENSE"
  "README.md"
  "SECURITY.md"
  "docs/azure-canary-deployment.md"
  "host.json"
  "infra/main.bicep"
  "infra/tenant.bicep"
  "package.json"
  "package-lock.json"
  "scripts/build-function-release.sh"
  "scripts/install-tenant.sh"
  "scripts/tenant-lifecycle-common.sh"
  "scripts/uninstall-tenant.sh"
  "scripts/validate-infrastructure-template.mjs"
  "scripts/validate-baseline.sh"
  "src/recording-access.mjs"
  "src/azure-runtime.mjs"
  "src/canary-runtime.mjs"
  "src/functions/recording-discovery-canary.mjs"
  "src/recording-discovery.mjs"
  "test/recording-access.integration.test.mjs"
  "test/recording-access.unit.test.mjs"
  "test/canary-runtime.integration.test.mjs"
  "test/canary-runtime.unit.test.mjs"
  "test/infrastructure.integration.test.mjs"
  "test/release-package.integration.test.mjs"
  "test/recording-discovery.integration.test.mjs"
  "test/recording-discovery.unit.test.mjs"
  "test/tenant-lifecycle.integration.test.mjs"
)

for path in "${required_files[@]}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Required baseline file is missing: ${path}" >&2
    exit 1
  fi
done

tracked_forbidden="$(
  git ls-files |
    grep -E '(^|/)work/reviews/|(^|/)\.env($|\.)|\.(key|pem|p12|pfx)$' |
    grep -Ev '(^|/)\.env\.example$' || true
)"

if [[ -n "${tracked_forbidden}" ]]; then
  echo "Forbidden local or sensitive files are tracked:" >&2
  echo "${tracked_forbidden}" >&2
  exit 1
fi

if ! grep -Fq "Issues are tracked exclusively in GitHub." AGENTS.md; then
  echo "AGENTS.md must declare GitHub as the exclusive issue source." >&2
  exit 1
fi

unpinned_actions="$(
  grep -E '^[[:space:]]+uses:' .github/workflows/baseline.yml |
    grep -Ev '@[0-9a-f]{40}([[:space:]]+#.*)?$' || true
)"

if [[ -n "${unpinned_actions}" ]]; then
  echo "Every external GitHub Action must use an immutable commit SHA:" >&2
  echo "${unpinned_actions}" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]+contents: read$' .github/workflows/baseline.yml; then
  echo "The baseline workflow must declare read-only contents permission." >&2
  exit 1
fi

if grep -Eq '^[[:space:]]+[a-z-]+: write$' .github/workflows/baseline.yml; then
  echo "The baseline workflow must not request write permissions." >&2
  exit 1
fi

echo "Repository baseline validation passed."
