# SCAFFOLD collaboration workflow

How SCAFFOLD keeps several tickets in development at once from conflicting with each other or causing regressions (PLAN.md section 8). The development loops from `workflow.md` are collapsed into single grey steps.

- **Check twice:** `conflict-check` runs once before implementation starts (requirements and plan) and once after code-owner approval, before the PR is given a merge position.
- **Find:** before each check, Actions code shortlists overlapping work deterministically: same spec section, Jira epic or affected paths as other in-flight tickets, approved PRs and changes merged since the first check.
- **Judge:** the `conflict-check` skill decides whether each overlap is a real conflict or regression risk, and explains why.
- **Flag:** Actions applies `scaffold:conflict` and posts one conflict comment linking every ticket involved. Implementation and merging are blocked while the flag is open.
- **Queue:** the Projects "Conflicts" view lists flagged tickets by priority. The flow lead and the owners of the tickets involved resolve them.
- **Merge order:** Actions orders approved PRs: blockers first, stacked PRs bottom-up, then priority, then earliest approval. Developers add PRs to the merge queue in that order; a check fails if a PR jumps the order.

Same key as `workflow.md`, plus grey for existing steps.

## Proposed

```mermaid
flowchart TD
  subgraph key[Key]
    direction LR
    kx[Existing steps<br/>slices 1-4, simplified]
    k5[5. Collaboration]
    kp[Planned]
    kd[Done]
    kh{"<span style='font-size:2em'>🧑</span><br/>Human<br/>must act"}
    ka{{Automated<br/>check}}
    kai["<span style='font-size:2em'>🤖</span> AI step"]
    kx ~~~ k5 ~~~ kp ~~~ kd
    kh ~~~ ka ~~~ kai
  end
  style key fill:#fff,stroke:#000
  key ~~~ ticket

  ticket[New or edited ticket] --> intake[Intake and triage]
  intake --> limit{{In-flight limit reached?<br/>max_in_flight, default 20}}
  limit -- yes: waits in Ready queue --> intake
  limit -- no --> plan[Plan and approve<br/>plan lists affected paths]

  plan --> find1{{Find overlapping in-flight work<br/>same spec section, Jira epic<br/>or affected paths}}
  find1 --> check1["<span style='font-size:2em'>🤖</span> conflict-check 1: before implementation<br/>requirements and plan<br/>vs spec and in-flight work"]
  check1 --> ok1{{Conflict or<br/>regression risk?}}
  ok1 -- no --> impl[Ticket implemented<br/>and code-owner approved]

  impl --> find2{{Find overlapping approved PRs<br/>and changes merged since check 1}}
  find2 --> check2["<span style='font-size:2em'>🤖</span> conflict-check 2: before merge order<br/>approved PR vs main<br/>and other approved PRs"]
  check2 --> ok2{{Conflict or<br/>regression risk?}}
  ok2 -- no --> order{{Assign merge order<br/>1. blockers first<br/>2. stacked PRs bottom-up<br/>3. priority<br/>4. earliest approval}}
  order --> enqueue{"<span style='font-size:2em'>🧑</span><br/>Developer adds PR<br/>to merge queue<br/>when next in order"}
  enqueue --> mq{{Merge queue<br/>merge-order check, then tests<br/>the PR with main and the PRs ahead}}
  mq -- passes --> merged[Merged to main]
  merged -. next PR in order .-> order
  blocked <-.-|unblocks| merged

  ok1 -- yes --> flag
  ok2 -- yes --> flag
  mq -- fails --> flag
  flag[scaffold:conflict<br/>conflict comment links every ticket involved<br/>implementation and merging blocked] --> queue[Projects view: Conflicts queue<br/>ordered by priority]
  queue --> resolve{"<span style='font-size:2em'>🧑</span><br/>Flow lead and<br/>ticket owners resolve"}
  resolve -- no real conflict --> resolved[scaffold:conflict-resolved<br/>applied by a listed approver]
  resolved --> resume[Resume at the step that flagged it]
  resolve -- sequence --> blocked[Blocked by the other ticket<br/>resumes when it merges]
  blocked --> resume
  resolve -- replan --> plan
  resolve -- change requirement --> intake
  resolve -- drop or merge tickets --> closed[Ticket closed]
  resume ~~~ merged
  closed ~~~ merged

  linkStyle default stroke-width:3px

  classDef existing fill:#4b5563,color:#fff
  classDef s5 fill:#0f766e,color:#fff
  classDef planned stroke:#dc2626,stroke-width:4px
  classDef done stroke:#3b82f6,stroke-width:4px
  classDef legend fill:#e5e7eb,color:#000

  class kx existing
  class k5 s5
  class kp,kd,kh,ka,kai legend
  class kp planned
  class kd done

  class ticket,intake,limit,plan,impl,merged existing
  class find1,check1,ok1,find2,check2,ok2,order,enqueue,mq,flag,queue,resolve,resolved,resume,blocked,closed s5

  class ticket,intake,limit,plan,impl,merged planned
  class find1,check1,ok1,find2,check2,ok2,order,enqueue,mq,flag,queue,resolve,resolved,resume,blocked,closed planned
```

## History

| Slice | Date | Change |
| --- | --- | --- |
| 0 | 2026-11-13 | Proposed collaboration workflow drawn |
