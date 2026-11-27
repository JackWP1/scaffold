<!-- scaffold:scenarios -->
### SCAFFOLD scenarios

Source: written by hand (intake stage off). These are what "done" looks like: the plan, tests and review are checked against them.

| # | Scenario |
| --- | --- |
| S1 | <scenario name> |

```gherkin
Feature: <what the issue changes>

  @scaffold-<issue>-S1
  Scenario: <scenario name>
    Given <starting state>
    When <action>
    Then <observable outcome>
```

A listed approver who isn't the issue author reviews these and applies `scaffold:gherkin-approved`. Any edit to this comment withdraws the approval.
