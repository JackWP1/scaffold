---
applyTo: ".github/workflows/**,templates/caller/.github/workflows/**"
excludeAgent: "coding-agent"
---

# Release pins: review note

Internal `uses: JackWP1/scaffold/...@<sha> # vX.Y.Z` refs in these files are moved by `scripts/release.sh`, not by hand (PLAN.md section 5). On a feature branch they still point at the previous release's commits, so a new action or reusable workflow added on the branch won't exist at the pinned SHA yet. That is expected: the release is cut on the branch before it merges, and the script re-pins every internal ref to the new release's commits.

When reviewing:

- Don't flag an internal pin that points at a commit missing a file the branch adds, or that still names the previous release (`# vX.Y.Z`). The release step fixes it.
- Do flag an internal ref that isn't a full 40-character commit SHA, a pin to another repository, or an internal path that doesn't exist on the branch itself (`packages/core/tests/pins.test.mjs` checks this too).
