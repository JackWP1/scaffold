---
name: implement
description: Turn an approved SCAFFOLD plan into PRs that pass SCAFFOLD's checks.
---

<!-- Adapted from mattpocock/skills (skills/engineering/implement) at 6f7f783. MIT licence, Copyright (c) 2026 Matt Pocock: see THIRD_PARTY_NOTICES.md. -->

# Implement a SCAFFOLD issue

1. **Read the issue and the approved plan.** State the issue's title before you start. The plan comment (it starts with `<!-- scaffold:plan -->`) gives the approach, the sub-tasks and, for a stack, one PR per sub-task in order. Do only what the plan and the issue ask; don't add scope. If they're ambiguous, say so in the PR description rather than guessing.
2. **Link the issue.** Every PR description includes `Fixes #<issue>`.
3. **One PR, or a stack.** If the plan is one PR, open one. If it's a stack, open one PR per sub-task, each based on the one below it (the first on the default branch), and build them bottom-up.
4. **Follow the `tdd` skill** at the plan's seams: scenarios and tests first.
5. **Check as you go.** Run the type checker regularly and single test files regularly; run the full test suite once at the end, before you push.
6. **Stay within the size limits.** Keep each PR within the soft limit in `.github/scaffold-config.yml` (`pr_size.soft`; exempt files don't count). If you can't, split it into a stack rather than growing one PR.
7. **Don't touch protected paths.** `.github/**`, `CODEOWNERS`, `PRECEDENTS.md` and `docs/spec/**` are for humans; a PR that changes them fails.
8. **Push to the PR's branch.** SCAFFOLD's checks and code-review run on each push.
9. **Rework rounds.** When SCAFFOLD comments `@copilot Rework round …`, fix every failing check and code-review thread it lists, reply on each thread with what you changed, then push. Don't argue with a check in a comment: fix the code, or explain in the PR description why a human should look.
