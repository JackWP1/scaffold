<!-- scaffold:plan -->
### SCAFFOLD plan

**Estimated size:** FILES files / LINES lines (soft limit SOFT_FILES files / SOFT_LINES lines) · **Delivered as:** one PR | a stack of PRs, merged bottom-up

> Written by hand: the `plan` stage is off (packages/plan/HANDOFF.md). Copy this whole comment, including the first line, fill it in and delete this note. Take SOFT_FILES and SOFT_LINES from `pr_size.soft`, and the stack limit from `max_stack_prs`, in this repo's `.github/scaffold-config.yml`.

#### Approach

How the work will be done, in a few plain sentences. Do any prefactoring first.

#### Acceptance criteria

- Testable statement of done

#### Affected paths

- `path/or/glob/**`

#### Sub-tasks

For a stack, one sub-task per PR, bottom-up; at most `max_stack_prs` (from `.github/scaffold-config.yml`), each within the soft limit above.

**1. Title** (FILES files / LINES lines)

What this step delivers.

- Acceptance criterion

**2. Title** (FILES files / LINES lines · blocked by 1)

What this step delivers.

- Acceptance criterion

#### Risks

- Regressions, unclear requirements or conflicts a reviewer should check

---
A listed approver reviews this plan and applies `scaffold:plan-approved`. Editing this comment withdraws any approval.
