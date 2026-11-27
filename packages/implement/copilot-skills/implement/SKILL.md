---
name: implement
description: Turn an approved SCAFFOLD plan into PRs that pass SCAFFOLD's checks.
---

# Implement a SCAFFOLD issue

1. **Read the approved plan.** The issue's plan comment (it starts with `<!-- scaffold:plan -->`) gives the approach, the sub-tasks and, for a stack, one PR per sub-task in order. Do only what the plan and the issue ask; don't add scope.
2. **Link the issue.** Every PR description includes `Fixes #<issue>`.
3. **One PR, or a stack.** If the plan is one PR, open one. If it's a stack, open one PR per sub-task, each based on the one below it (the first on the default branch), and build them bottom-up.
4. **Stay within the size limits.** Keep each PR within the soft limit in `.github/scaffold-config.yml` (`pr_size.soft`; exempt files don't count). If you can't, split it into a stack rather than growing one PR.
5. **Don't touch protected paths.** `.github/**`, `CODEOWNERS`, `PRECEDENTS.md` and `docs/spec/**` are for humans; a PR that changes them fails.
6. **Follow the `tdd` skill.** Scenarios and tests first.
7. **Rework rounds.** When SCAFFOLD comments `@copilot Rework round …`, fix every check it lists, then push. Don't argue with a check in a comment: fix the code, or explain in the PR description why a human should look.
