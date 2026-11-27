---
name: tdd
description: Write the failing tests and scenarios for a SCAFFOLD PR first, then make them pass.
---

# Test-driven development

Use this for every PR you open for a SCAFFOLD issue.

1. **Scenarios first.** If the issue has an approved scenarios comment (it starts with `<!-- scaffold:scenarios -->`), find the scenarios the plan gives this PR (the plan comment lists `Scenarios: S1, …` under each sub-task). Copy each one exactly as approved into a `.feature` file under `features/`, keeping its `@scaffold-<issue>-S<n>` tag. Don't reword a step: the scenarios check compares the steps with the approved text. Write the step definitions, run the BDD runner, and see each scenario fail.
2. **Unit tests next.** For each behaviour, write one failing test, make it pass with the smallest change, then refactor. Repeat.
3. **Keep every existing test.** Don't delete, skip, focus or weaken tests or assertions, and don't change existing scenarios: the test integrity check fails the PR and a human must approve it. If a test is genuinely wrong, say so in the PR description instead.
4. **Finish green.** All tests and scenarios pass locally before you push. The BDD runner report from CI must show every scenario for this PR passed.
