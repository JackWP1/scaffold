#!/usr/bin/env bash
# Cuts a release by pinning every internal ref to an immutable SHA (PLAN.md section 5).
#   Commit A: current HEAD, holding the action code being released.
#   Commit B: reusable workflows pin actions/* to A. Tagged <version>.
#   Commit C: caller template pins the reusable workflows to B.
# A workflow can't pin the commit that contains it, hence the extra commits.
# Merge with a merge commit (not squash or rebase) so A and B stay reachable.
set -euo pipefail

version=${1:?usage: scripts/release.sh vX.Y.Z}
repo=JackWP1/scaffold
cd "$(git rev-parse --show-toplevel)"
[[ -z $(git status --porcelain) ]] || { echo "Working tree not clean" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$version" >/dev/null || { echo "Tag $version exists" >&2; exit 1; }

pin() { # pin <path-regex> <sha> <files...>
  local path=$1 sha=$2; shift 2
  perl -pi -e "s{(uses:\s*\Q$repo\E/$path)\@\S+(\s+#.*)?\$}{\$1\@$sha # $version}" "$@"
}

a=$(git rev-parse HEAD)
pin 'actions/[\w-]+' "$a" .github/workflows/*.yml
git commit -qam "Release $version: pin actions to ${a:0:7}"
b=$(git rev-parse HEAD)
git tag -a "$version" -m "SCAFFOLD $version" "$b"

pin '\.github/workflows/[\w-]+\.yml' "$b" templates/caller/.github/workflows/*.yml
git commit -qam "Release $version: pin caller template to ${b:0:7}"

echo "Tagged $version at ${b:0:7}. Push with: git push && git push origin $version"
