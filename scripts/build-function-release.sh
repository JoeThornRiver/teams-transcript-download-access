#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: build-function-release.sh <git-revision> <output-zip>" >&2
  exit 64
fi

revision="$1"
requested_output="$2"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
output_directory="$(dirname "$requested_output")"
output_name="$(basename "$requested_output")"

if [[ ! -d "$output_directory" ]]; then
  echo "Release output directory does not exist." >&2
  exit 65
fi

output_directory="$(cd "$output_directory" && pwd -P)"
output_path="${output_directory}/${output_name}"
if [[ -e "$output_path" ]]; then
  echo "Release output already exists." >&2
  exit 66
fi

commit="$(git -C "$repository_root" rev-parse --verify "${revision}^{commit}")"
staging_parent="$(mktemp -d)"
staging_root="${staging_parent}/source"
staging_archive="${staging_parent}/release-package.zip"
publication_temp=""

cleanup() {
  if [[ -n "$publication_temp" ]]; then
    rm -f "$publication_temp"
  fi
  rm -rf "$staging_parent"
}
trap cleanup EXIT

mkdir "$staging_root"
git -C "$repository_root" archive --format=tar "$commit" | tar -xf - -C "$staging_root"

for required_file in host.json package.json package-lock.json; do
  if [[ ! -f "${staging_root}/${required_file}" ]]; then
    echo "Reviewed revision is missing a required runtime file." >&2
    exit 67
  fi
done
if [[ ! -d "${staging_root}/src" ]]; then
  echo "Reviewed revision must contain exactly one Function entry point." >&2
  exit 70
fi

if [[ -n "$(find \
  "${staging_root}/host.json" \
  "${staging_root}/package.json" \
  "${staging_root}/package-lock.json" \
  "${staging_root}/src" \
  -type l -print -quit)" ]]; then
  echo "Reviewed runtime inputs must not contain symbolic links." >&2
  exit 68
fi

declared_entry_point="$(
  cd "$staging_root"
  node -e 'const value = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).main; if (typeof value === "string") process.stdout.write(value);'
)"
if [[ "$declared_entry_point" != "src/functions/*.mjs" ]]; then
  echo "Package metadata must declare the Azure Functions entry-point glob." >&2
  exit 69
fi

function_count="$({ find "${staging_root}/src/functions" -maxdepth 1 -type f -name '*.mjs' 2>/dev/null || true; } | wc -l | tr -d '[:space:]')"
if [[ "$function_count" -ne 1 ]]; then
  echo "Reviewed revision must contain exactly one Function entry point." >&2
  exit 70
fi

(
  cd "$staging_root"
  npm ci --omit=dev
)
mkdir -p "${staging_root}/node_modules"

(
  cd "$staging_root"
  zip -qr "$staging_archive" host.json package.json package-lock.json src node_modules
)

unzip -tqq "$staging_archive"
archive_entries="$(unzip -Z1 "$staging_archive")"
for required_entry in host.json package.json package-lock.json; do
  if ! grep -Fxq "$required_entry" <<<"$archive_entries"; then
    echo "Release archive is missing a required runtime file." >&2
    exit 71
  fi
done

while IFS= read -r entry; do
  case "$entry" in
    host.json|package.json|package-lock.json|src/|src/*|node_modules/|node_modules/*)
      ;;
    *)
      echo "Release archive contains a non-runtime path." >&2
      exit 72
      ;;
  esac
done <<<"$archive_entries"

publication_temp="$(mktemp "${output_directory}/.${output_name}.XXXXXX")"
cp "$staging_archive" "$publication_temp"
unzip -tqq "$publication_temp"
ln "$publication_temp" "$output_path"
rm "$publication_temp"
publication_temp=""
echo "Release package created."
