# SCAFFOLD workflow

Two diagrams, kept as code (PLAN.md section 10). How concurrent tickets are checked for conflicts is in `collaboration.md`.

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
    k5[5. Collaboration]
    kp[Planned]
    kd[Done]
    kh{"<span style='font-size:2em'>🧑</span><br/>Human<br/>must act"}
    ka{{Automated<br/>check}}
    kai["<span style='font-size:2em'>🤖</span> AI step"]
    k1 ~~~ k2 ~~~ k3 ~~~ k4 ~~~ k5
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
  plancmd --> limit{{In-flight limit reached?<br/>max_in_flight, default 20}}
  limit -- yes: waits in Ready --> ready
  limit -- no --> decompose["<span style='font-size:2em'>🤖</span> task-decomposer"]
  decompose --> plansize{{Estimated size over soft limit?<br/>10 files or 1000 lines}}
  plansize -- no --> plancomment[Plan comment]
  plansize -- yes --> split["<span style='font-size:2em'>🤖</span> task-decomposer splits work<br/>into a stack of PRs or up to 5 sub-tickets"]
  split --> plancomment
  split -- needs more than 5 sub-tickets --> planreview
  plancomment --> planreview{"<span style='font-size:2em'>🧑</span><br/>Approver<br/>reviews plan"}
  planreview -- changes needed --> plancmd
  planreview -- approves --> approved[scaffold:plan-approved<br/>gate: listed approver + plan hash]

  approved --> check1["<span style='font-size:2em'>🤖</span> conflict-check 1<br/>before implementation:<br/>vs spec and in-flight work"]
  check1 -- conflict --> conflicts1[scaffold:conflict<br/>Conflicts queue for human review<br/>see collaboration.md]
  check1 -- no conflict --> assign{"<span style='font-size:2em'>🧑</span><br/>Developer assigns<br/>issue to Copilot"}
  assign --> copilot["<span style='font-size:2em'>🤖</span> Copilot coding agent<br/>tdd, implement"]
  copilot --> pr[Copilot PR]
  pr --> guards{{Guard checks<br/>plan gate, protected paths, test integrity}}
  pr --> prsize{{PR size check<br/>soft: 10 files / 1000 lines<br/>hard: 30 files / 5000 lines<br/>exempt files excluded}}
  prsize -- within soft limit --> readygate
  prsize -- over soft, within hard --> sizecmd{"<span style='font-size:2em'>🧑</span><br/>Developer may comment<br/>/size-exception reason"}
  prsize -- over hard --> breaker{{Circuit breaker<br/>6 rework rounds used?}}
  sizecmd --> sizeexc{"<span style='font-size:2em'>🧑</span><br/>Listed approver decides<br/>scaffold:size-exception"}
  sizeexc -- accepted --> readygate
  pr --> ci{{CI}}
  pr --> review["<span style='font-size:2em'>🤖</span> code-review"]
  ci -- fails --> diagnose["<span style='font-size:2em'>🤖</span> ci-diagnose"]
  guards --> readygate
  ci -- passes --> readygate
  diagnose --> readygate
  review --> readygate{{Ready for human review?<br/>guard checks pass, CI passes,<br/>all code-review comments resolved,<br/>within soft size limit or exception}}
  readygate -- no --> breaker{{Circuit breaker<br/>6 rework rounds used?}}
  breaker -- no --> rework[Automatic rework round<br/>Actions asks @copilot to fix checks, resolve comments<br/>and split oversized work into stacked PRs;<br/>no human approval]
  rework --> copilot
  breaker -- yes --> escalate[scaffold:escalate<br/>circuit breaker tripped;<br/>size exception requested if oversized]
  escalate --> ownerreview
  readygate -- yes --> ownerreview{"<span style='font-size:2em'>🧑</span><br/>Code-owner<br/>review"}
  ownerreview -- changes requested --> copilot
  ownerreview -- needs replanning --> ready
  ownerreview -- approves --> check2["<span style='font-size:2em'>🤖</span> conflict-check 2<br/>before merge order:<br/>vs main and approved PRs"]
  check2 -- conflict --> conflicts2[scaffold:conflict<br/>Conflicts queue for human review<br/>see collaboration.md]
  check2 -- no conflict --> order{{Assign merge order<br/>blockers, stacks, priority,<br/>approval time}}
  order --> merge{"<span style='font-size:2em'>🧑</span><br/>Developer adds PR<br/>to merge queue<br/>when next in order"}
  merge --> mq{{Merge queue<br/>merge-order check, then tests<br/>with main and PRs ahead}}
  mq -- fails --> mainonly{{Fails with just main?}}
  mainonly -- yes: automatic rework --> breaker
  mainonly -- no --> conflicts2
  mq -- passes --> closed[Merged, issue closed<br/>Projects: Done]
  conflicts2 ~~~ closed


  linkStyle default stroke-width:3px

  classDef s1 fill:#1e40af,color:#fff
  classDef s2 fill:#166534,color:#fff
  classDef s3 fill:#a16207,color:#fff
  classDef s4 fill:#9d174d,color:#fff
  classDef s5 fill:#0f766e,color:#fff
  classDef planned stroke:#dc2626,stroke-width:4px
  classDef done stroke:#3b82f6,stroke-width:4px
  classDef legend fill:#e5e7eb,color:#000

  class k1 s1
  class k2 s2
  class k3 s3
  class k4 s4
  class k5 s5
  class kp,kd,kh,ka,kai legend
  class kp planned
  class kd done

  class jira,open,member,proposed,accept,triage,needsinfo,edit,ready s1
  class plancmd,limit,decompose,plansize,split,plancomment,planreview,approved s2
  class assign,copilot,pr,guards,rework,breaker,escalate,sizeexc,sizecmd,prsize,ownerreview,closed s3
  class ci,review,diagnose,readygate s4
  class check1,check2,conflicts1,conflicts2,order,merge,mq,mainonly s5

  class jira,open,member,proposed,accept,triage,needsinfo,edit,ready planned
  class plancmd,limit,decompose,plansize,split,plancomment,planreview,approved planned
  class assign,copilot,pr,guards,rework,breaker,escalate,sizeexc,sizecmd,prsize,ownerreview,closed planned
  class ci,review,diagnose,readygate planned
  class check1,check2,conflicts1,conflicts2,order,merge,mq,mainonly planned
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
