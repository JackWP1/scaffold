# SCAFFOLD workflow

Two diagrams, kept as code (PLAN.md section 10):

- **Proposed:** the target lifecycle. Hand-maintained; a PR that changes it is a proposal to change the workflow.
- **Current:** the workflow as implemented. Updated at the end of every slice; from slice 1 it is generated from `config/workflow.yml` and the `scaffold-diagrams` check fails if it is stale.

## Proposed

Fill colour shows the slice that delivers each step; the border shows whether it is planned or done. The slice's PR switches its steps from `planned` to `done`.

Shape shows who moves the work on: a diamond with 🧑 needs a human to act; a hexagon is an automated check; 🤖 is an AI step; a plain box is a state or artefact. See the key at the top.

```mermaid
flowchart TD
  subgraph key[Key]
    direction LR
    k1[1. Intake]
    k2[2. Plan]
    k3[3. Implement]
    k4[4. Review]
    kp[Planned]
    kd[Done]
    kh{"<span style='font-size:2em'>🧑</span><br/>Human<br/>must act"}
    ka{{Automated<br/>check}}
    kai["<span style='font-size:2em'>🤖</span> AI step"]
    k1 ~~~ k2 ~~~ k3 ~~~ k4
    kp ~~~ kd ~~~ kh ~~~ ka ~~~ kai
  end
  style key fill:#fff,stroke:#000
  key ~~~ jira

  jira[Jira requirement] --> open{"<span style='font-size:2em'>🧑</span><br/>Developer opens issue<br/>via Jira issue form"}
  open --> member{{Author is a trusted org<br/>member or collaborator?}}
  member -- no --> proposed[scaffold:proposed]
  proposed --> accept{"<span style='font-size:2em'>🧑</span><br/>Member applies<br/>scaffold:accepted"}
  accept --> triage
  member -- yes --> triage["<span style='font-size:2em'>🤖</span> triage"]
  triage --> needsinfo[scaffold:needs-info]
  needsinfo --> edit{"<span style='font-size:2em'>🧑</span><br/>Author<br/>edits issue"}
  edit --> triage
  triage --> ready[scaffold:ready<br/>Projects: Ready]

  ready --> plancmd{"<span style='font-size:2em'>🧑</span><br/>Member<br/>comments /plan"}
  plancmd --> decompose["<span style='font-size:2em'>🤖</span> task-decomposer"]
  decompose --> plancomment[Plan comment]
  plancomment --> planreview{"<span style='font-size:2em'>🧑</span><br/>Approver<br/>reviews plan"}
  planreview -- changes needed --> plancmd
  planreview -- approves --> approved[scaffold:plan-approved<br/>gate: listed approver + plan hash]

  approved --> assign{"<span style='font-size:2em'>🧑</span><br/>Developer assigns<br/>issue to Copilot"}
  assign --> copilot["<span style='font-size:2em'>🤖</span> Copilot coding agent<br/>tdd, implement"]
  copilot --> pr[Copilot PR]
  pr --> guards{{Guard checks<br/>plan gate, protected paths, test integrity}}
  pr --> ci{{CI}}
  pr --> review["<span style='font-size:2em'>🤖</span> code-review"]
  ci -- fails --> diagnose["<span style='font-size:2em'>🤖</span> ci-diagnose"]
  guards --> readygate
  ci -- passes --> readygate
  diagnose --> readygate
  review --> readygate{{Ready for human review?<br/>guard checks pass, CI passes,<br/>all code-review comments resolved}}
  readygate -- no --> breaker{{Circuit breaker<br/>6 rework rounds used?}}
  breaker -- no --> rework[Automatic rework round<br/>Actions asks @copilot to fix checks<br/>and resolve comments; no human approval]
  rework --> copilot
  breaker -- yes --> escalate[scaffold:escalate]
  escalate --> ownerreview
  readygate -- yes --> ownerreview{"<span style='font-size:2em'>🧑</span><br/>Code-owner<br/>review"}
  ownerreview -- changes requested --> copilot
  ownerreview -- needs replanning --> ready
  ownerreview -- approves --> merge{"<span style='font-size:2em'>🧑</span><br/>Developer<br/>merges"}
  merge --> closed[Issue closed<br/>Projects: Done]

  linkStyle default stroke-width:3px

  classDef s1 fill:#1e40af,color:#fff
  classDef s2 fill:#166534,color:#fff
  classDef s3 fill:#a16207,color:#fff
  classDef s4 fill:#9d174d,color:#fff
  classDef planned stroke:#dc2626,stroke-width:4px
  classDef done stroke:#3b82f6,stroke-width:4px
  classDef legend fill:#e5e7eb,color:#000

  class k1 s1
  class k2 s2
  class k3 s3
  class k4 s4
  class kp,kd,kh,ka,kai legend
  class kp planned
  class kd done

  class jira,open,member,proposed,accept,triage,needsinfo,edit,ready s1
  class plancmd,decompose,plancomment,planreview,approved s2
  class assign,copilot,pr,guards,rework,breaker,escalate,ownerreview,merge,closed s3
  class ci,review,diagnose,readygate s4

  class jira,open,member,proposed,accept,triage,needsinfo,edit,ready planned
  class plancmd,decompose,plancomment,planreview,approved planned
  class assign,copilot,pr,guards,rework,breaker,escalate,ownerreview,merge,closed planned
  class ci,review,diagnose,readygate planned
```

Visibility is part of every slice rather than a stage of its own: each slice adds its steps to the status comment, audit log, usage report and these diagrams (PLAN.md section 11).

## Current

As of: **before slice 1**. Assumed manual workflow; confirm with the pilot developers in Phase 0.

```mermaid
flowchart TD
  jira[Jira ticket created] --> refined[Ticket refined]
  refined --> planned[Ticket planned]
  planned --> pick{Developer picks up Jira ticket}
  pick --> code[Developer writes code]
  code --> pr[PR]
  pr --> ci{CI}
  ci -- fails --> code
  ci -- passes --> review{Peer review}
  review -- changes requested --> code
  review -- approves --> test{Ticket tested}
  test -- fails: changes requested --> code
  test -- passes --> merge[Developer merges]
  merge --> closed[Jira ticket closed]
```

## History

One row per slice, added in the slice's retrospective PR. Earlier versions of both diagrams are in git history.

| Slice | Date | Change |
| --- | --- | --- |
| 0 | 2026-11-13 | Proposed workflow drawn; current workflow assumed manual |
