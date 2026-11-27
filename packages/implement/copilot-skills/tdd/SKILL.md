---
name: tdd
description: Test-driven development for a SCAFFOLD PR: the approved scenarios and failing tests first, at the plan's seams, then the smallest code to pass them.
---

<!-- Adapted from mattpocock/skills (skills/engineering/tdd) at 6f7f783. MIT licence, Copyright (c) 2026 Matt Pocock: see THIRD_PARTY_NOTICES.md. -->

# Test-driven development

TDD is the red → green loop. This is how to make that loop produce tests worth keeping on a SCAFFOLD PR: what a good test is, where tests go, the anti-patterns and the rules of the loop. Every section applies on every cycle. Read `GLOSSARY.md` if the repo has one, so test names use the project's domain language, and respect ADRs in the area you're touching.

## Scenarios first

If the issue has an approved scenarios comment (it starts with `<!-- scaffold:scenarios -->`), find the scenarios the plan gives this PR (the plan comment lists `Scenarios: S1, …` under each sub-task). Copy each one exactly as approved into a `.feature` file under `features/`, keeping its `@scaffold-<issue>-S<n>` tag. Don't reword a step: the scenarios check compares the steps with the approved text. Write the step definitions, run the BDD runner and see each scenario fail. The scenarios are the outermost seam; the unit tests below drive the code that makes them pass.

## What a good test is

Tests verify behaviour through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification ("user can check out with a valid cart") and survives refactors because it doesn't care about internal structure. See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for when to mock.

## Seams: where tests go

A seam is the public boundary you test at: the interface where you observe behaviour without reaching inside. Tests live at seams, never against internals.

Test only at agreed seams. You can't ask a person here, so the plan is the agreement: the seams are the interfaces the plan's sub-task and its affected paths name, plus the approved scenarios. Before writing a test, write down in the PR description the seams under test and, in one line each, what each catches and what it misses. Don't add tests at other seams; if the plan's seams look wrong, say so in the PR description.

## Anti-patterns

- **Implementation-coupled:** mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behaviour hasn't changed.
- **Tautological:** the assertion recomputes the expected value the way the code does, so it passes by construction. Expected values come from an independent source: a known literal, a worked example, the spec or the scenario.
- **Horizontal slicing:** writing all the tests first, then all the code. Work in vertical slices: one test, then the code for it, then the next, each responding to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring isn't part of the loop.** SCAFFOLD's code-review comments on it after you push; don't mix refactors into a red → green cycle.

## SCAFFOLD rules

- **Keep every existing test.** Don't delete, skip, focus or weaken tests or assertions, and don't change existing scenarios: the test integrity check fails the PR and a human must approve it. If a test is genuinely wrong, say so in the PR description instead.
- **Finish green.** All tests and scenarios pass before you push. CI's BDD runner report must show every scenario for this PR passed.
