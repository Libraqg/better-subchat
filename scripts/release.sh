#!/bin/sh
# Pre-release gate: `scripts/release.sh v0.3.0`. Checks that the tag, the
# manifest version and a dated CHANGELOG entry agree, runs every check, and
# prints the commands that tag and publish the release (it runs neither).
set -eu
cd "$(dirname "$0")/.."

tag=${1:?usage: scripts/release.sh vX.Y.Z}
version=${tag#v}
manifest=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' .claude-plugin/plugin.json)

[ "$tag" = "v$version" ] || { echo "tag must look like vX.Y.Z" >&2; exit 1; }
[ "$manifest" = "$version" ] || { echo "plugin.json version is $manifest, not $version" >&2; exit 1; }
grep -Eq "^## \[$version\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md || {
  echo "CHANGELOG.md needs a dated entry: ## [$version] - YYYY-MM-DD" >&2
  exit 1
}
command -v npx >/dev/null 2>&1 || { echo "tsc must pass before a release: install Node first" >&2; exit 1; }

./scripts/check.sh

echo
echo "All checks passed. To publish:"
echo "  git tag -a $tag -m \"better-subchat $tag\" && git push origin $tag"
echo "  gh release create $tag --title \"better-subchat $tag\" --notes-file <(sed -n '/^## \\[$version\\]/,/^## \\[/p' CHANGELOG.md | sed '\$d')"
