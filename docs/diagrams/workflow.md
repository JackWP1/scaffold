# SCAFFOLD workflow

Two diagrams, kept as code (PLAN.md section 10):

- **Proposed:** the target lifecycle. Hand-maintained; a PR that changes it is a proposal to change the workflow.
- **Current:** the workflow as implemented. Updated at the end of every slice; from slice 1 it is generated from `config/workflow.yml` and the `scaffold-diagrams` check fails if it is stale.

## Proposed

Fill colour shows the slice that delivers each step; the border shows whether it is planned or done (see the key at the top). The slice's PR switches its steps from `planned` to `done`.

Shapes: `{ }` human decision or gate, `[ ]` step, state or artefact.

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
    k1 ~~~ k2 ~~~ k3 ~~~ k4 ~~~ kp ~~~ kd
  end
  style key fill:#fff,stroke:#000
  key ~~~ jira

  jira[Jira requirement] --> form[Issue opened via Jira issue form]
  form --> member{Author is a member?}
  member -- no --> proposed[scaffold:proposed]
  proposed -- member applies scaffold:accepted --> triage
  member -- yes --> triage[triage]
  triage --> needsinfo[scaffold:needs-info]
  needsinfo -- author edits issue --> triage
  triage --> ready[scaffold:ready<br/>Projects: Ready]

  ready -- member comments /plan --> decompose[task-decomposer]
  decompose --> plancomment[Plan comment]
  plancomment --> planreview{Approver reviews plan}
  planreview -- changes needed: /plan again --> decompose
  planreview -- approves --> approved[scaffold:plan-approved<br/>gate: listed approver + plan hash]

  approved -- developer assigns issue --> copilot[Copilot coding agent<br/>tdd, implement]
  copilot --> pr[Copilot PR]
  pr --> guards{Guard checks<br/>plan gate, protected paths, test integrity}
  pr --> ci{CI}
  pr --> review[code-review]
  ci -- fails --> diagnose[ci-diagnose]
  diagnose --> rework[Rework round]
  guards -- fail --> rework
  rework --> breaker{Circuit breaker<br/>4 consecutive / 6 total}
  breaker -- under limit --> copilot
  breaker -- tripped --> escalate[scaffold:escalate]
  escalate --> flowlead{Flow lead decides}
  flowlead -- replan --> ready

  guards -- pass --> ownerreview{Code-owner review}
  ci -- passes --> ownerreview
  review --> ownerreview
  ownerreview -- changes requested --> rework
  ownerreview -- approves --> merge[Human merges]
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
  class kp,kd legend
  class kp planned
  class kd done

  class jira,form,member,proposed,triage,needsinfo,ready s1
  class decompose,plancomment,planreview,approved s2
  class copilot,pr,guards,rework,breaker,escalate,flowlead,ownerreview,merge,closed s3
  class ci,review,diagnose s4

  class jira,form,member,proposed,triage,needsinfo,ready planned
  class decompose,plancomment,planreview,approved planned
  class copilot,pr,guards,rework,breaker,escalate,flowlead,ownerreview,merge,closed planned
  class ci,review,diagnose planned
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
