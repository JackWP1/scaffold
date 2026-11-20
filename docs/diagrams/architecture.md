# SCAFFOLD architecture

Components and how they call each other (PLAN.md section 10). Updated in every slice's PR; hand-drawn until the `scaffold-diagrams` check generates it.

- **Calling repo:** a thin caller workflow and `.github/scaffold-config.yml`. The Request issue form comes from the `.github` repo.
- **SCAFFOLD repo:** reusable workflows call composite actions pinned to a release SHA; the actions bundle skills, schemas and config, so no cross-repo checkout is needed.
- **Model calls:** one tool-less Copilot CLI call per AI step. Actions code validates the JSON and makes every write with `GITHUB_TOKEN`.

As of: **slice 2**.

```mermaid
flowchart LR
  subgraph caller[Calling repo]
    direction TB
    events([issues, issue_comment,<br/>workflow_dispatch])
    callerwf[".github/workflows/scaffold.yml<br/>thin caller"]
    cfg[".github/scaffold-config.yml<br/>approvers, max_in_flight, pr_size"]
    events --> callerwf
  end

  form[".github repo<br/>Request issue form"] -. default template .-> events

  subgraph scaffold[SCAFFOLD repo, pinned release]
    direction TB
    subgraph wf[Reusable workflows]
      triagewf[triage.yml]
      planwf[plan.yml<br/>jobs: admit, plan, gate]
      labelswf[labels.yml]
    end
    subgraph actions[Composite actions]
      triage[actions/triage]
      plan[actions/plan<br/>modes: admit, plan]
      gate[actions/plan-gate]
      labels[actions/labels]
    end
    subgraph lib[actions/lib]
      gh[github.mjs<br/>REST client]
      models[models.mjs<br/>Copilot CLI, no tools]
      validate[validate.mjs]
      issue[issue.mjs<br/>labels, comments, timeline]
      status[status.mjs<br/>status comment gates]
      config[config.mjs<br/>scaffold-config.yml]
      skills[skills.mjs]
    end
    subgraph data[Bundled data]
      skillmd[skills/*/SKILL.md<br/>manifest.yml]
      schemas[schemas/*.json]
      cfgfiles[config/labels.yml<br/>config/models.yml]
    end
    triagewf --> triage
    planwf --> plan
    planwf --> gate
    labelswf --> labels
  end

  callerwf --> triagewf
  callerwf --> planwf
  callerwf --> labelswf

  triage --> models
  plan --> models
  triage & plan & gate --> validate
  triage & plan & gate --> issue
  triage & plan & gate --> status
  plan & gate --> config
  triage & plan --> skills
  skills --> skillmd
  skills --> cfgfiles
  validate --> schemas
  labels --> cfgfiles
  issue --> gh
  config --> gh
  labels --> gh

  config -. reads .-> cfg
  models --> copilot[(Copilot CLI<br/>OpenAI model)]
  gh --> api[(GitHub REST API<br/>GITHUB_TOKEN)]

  classDef ext fill:#4b5563,color:#fff
  classDef s1 fill:#1e40af,color:#fff
  classDef s2 fill:#166534,color:#fff
  class copilot,api,form,events ext
  class triagewf,triage,labelswf,labels,models,validate,issue,skills,skillmd,schemas,cfgfiles,gh s1
  class planwf,plan,gate,status,config,cfg s2
```

Fill shows the slice that added each component (blue: slice 1, green: slice 2; colours as in `workflow.md`); grey is outside SCAFFOLD.

## History

| Slice | Date | Change |
| --- | --- | --- |
| 2 | 2026-11-20 | Drawn: slice 1 triage and labels; slice 2 plan (admit and plan modes), plan gate, `scaffold-config.yml` config and status gates |
