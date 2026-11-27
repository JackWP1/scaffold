// ci-diagnose (PLAN.md section 2, slice 4): when a run of a workflow listed in `ci_workflows` fails on the
// PR's head commit, one tool-less model call explains it from the failed jobs' logs, posted as one
// diagnosis comment on the PR (updated in place). Waits for the runs on `pull_request` rather than using
// `workflow_run`, which would need the workflow names in the protected caller file. Imports only core.
import { createHash } from 'node:crypto';
import { wrapUntrusted, escapeForComment as e } from '../core/lib/text.mjs';
import { validate } from '../core/lib/validate.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { waitForRun } from '../core/lib/runs.mjs';
import { prFiles } from '../core/lib/pr.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const COPILOT = ['Copilot', 'copilot-swe-agent[bot]'];
export const DIAGNOSIS_MARKER = '<!-- scaffold:ci-diagnosis';
const FAILED = ['failure', 'timed_out', 'startup_failure'];
// PR events that can bring a new head commit; labels and edits don't.
const HEAD_EVENTS = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
const MAX_JOBS = 4;
const LOG_TAIL = 6000;
const heading = '### SCAFFOLD ci-diagnose';

// A job log's last `max` characters, without timestamps or terminal colour codes.
export function cleanLog(text, max = LOG_TAIL) {
  const clean = String(text ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, '')
    .trim();
  return clean.length > max ? `…\n${clean.slice(-max)}` : clean;
}

// Actions masks registered secrets in logs (as ***), but a credential it doesn't know about can still
// be there. Secret-shaped text is replaced before the logs reach the model, and again in its output
// before anything is posted. Pattern-based, so it narrows the risk rather than removing it.
export const redact = (text) => String(text ?? '')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<REDACTED>')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '<REDACTED>')
  .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 <REDACTED>')
  .replace(/\b([A-Za-z_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credential)[A-Za-z_]*)(\s*[:=]\s*)(["']?)[^\s"',;]{6,}\3/gi, '$1$2$3<REDACTED>$3')
  .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1<REDACTED>@');

// Longer than any backtick run in the text, so a log excerpt can't close its fence.
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([m]) => m.length + 1)));

export function renderDiagnosis(raw, { sha, runs, skillVersion, model }) {
  const out = JSON.parse(JSON.stringify(raw), (k, v) => (typeof v === 'string' ? redact(v) : v));
  const loopFence = fence(out.loop);
  return [
    `${DIAGNOSIS_MARKER} ${sha} -->`,
    `### SCAFFOLD CI diagnosis: ${sha.slice(0, 7)}`,
    '',
    `Failed: ${runs.map((r) => `[${e(r.name)}](${r.html_url})`).join(', ')}`,
    '',
    `**${e(out.summary)}**`,
    '',
    `**Category:** ${out.category} · **Confidence:** ${out.confidence}`,
    '',
    `**Cause:** ${e(out.cause)}`,
    '',
    '**Reproduce:** this should go red on the failure locally.',
    '',
    `${loopFence}sh`,
    out.loop,
    loopFence,
    '',
    `**Fix:** ${e(out.fix)}`,
    ...(out.hypotheses.length ? ['', '**Hypotheses**, most likely first:', '', ...out.hypotheses.map((h, i) => `${i + 1}. ${e(h.cause)} *Test:* ${e(h.prediction)}`)] : []),
    ...out.evidence.flatMap((x) => {
      const f = fence(x.excerpt);
      return ['', `<details><summary>${e(x.job)}</summary>`, '', `${f}text`, x.excerpt, f, '', '</details>'];
    }),
    '',
    'React 👎 if this diagnosis is wrong: the usage report counts it as a false positive.',
    '',
    `<sub>ci-diagnose v${skillVersion} · ${model} · AI-generated: check before acting</sub>`,
  ].join('\n');
}

// Returns { skip } or { lines } for the job summary. Never fails the job.
export async function runCiDiagnose(gh, repo, { event, config, loadSkill, callModel, wait = {} }) {
  const pr = event.pull_request;
  if (!pr) return { skip: 'not a pull request' };
  if (!HEAD_EVENTS.includes(event.action)) return { skip: `${event.action}: only a new head commit is diagnosed` };
  if (!config.ci_workflows.length) return { skip: 'no `ci_workflows` in `.github/scaffold-config.yml`' };
  if (pr.head.repo?.full_name && pr.head.repo.full_name !== repo) return { skip: 'from a fork: not diagnosed' };
  if (!TRUSTED.includes(pr.author_association) && !COPILOT.includes(pr.user?.login)) return { skip: `opened by ${pr.author_association}: members and Copilot only` };
  const sha = pr.head.sha;
  const { findComment, upsertComment } = issueSteps(gh, repo, pr.number, []);
  if ((await findComment(`${DIAGNOSIS_MARKER} ${sha} -->`))) return { skip: `already diagnosed ${sha.slice(0, 7)}` };

  // All at once, so they share one deadline (15 minutes by default, inside the job's 30-minute timeout)
  // however many workflows are listed.
  const results = await Promise.all(config.ci_workflows.map(async (workflow) => ({ workflow, ...await waitForRun(gh, repo, workflow, sha, wait) })));
  const runs = [];
  const notes = [];
  for (const { workflow, run, pending, missing, notFound } of results) {
    if (notFound) notes.push(`\`${workflow}\`: workflow not found`);
    else if (missing) notes.push(`\`${workflow}\`: no run on ${sha.slice(0, 7)}`);
    else if (pending) notes.push(`\`${workflow}\`: still running at the deadline`);
    else if (FAILED.includes(run.conclusion)) runs.push(run);
  }
  if (!runs.length) return { lines: [heading, `No failed runs of ${config.ci_workflows.map((w) => `\`${w}\``).join(', ')} on ${sha.slice(0, 7)}.`, ...notes.map((n) => `- ${n}`)] };

  const logs = [];
  for (const run of runs) {
    const { jobs = [] } = await gh.get(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    for (const job of jobs.filter((j) => FAILED.includes(j.conclusion)).slice(0, MAX_JOBS - logs.length)) {
      let text;
      try {
        text = redact(cleanLog((await gh.download(`/repos/${repo}/actions/jobs/${job.id}/logs`)).toString('utf8')));
      } catch (err) {
        text = `(log unavailable: ${err.message})`;
      }
      logs.push(wrapUntrusted('untrusted_log', `Workflow: ${run.name}\nJob: ${job.name}\nFailed steps: ${(job.steps ?? []).filter((s) => FAILED.includes(s.conclusion)).map((s) => s.name).join(', ') || '(unknown)'}\n\n${text}`, LOG_TAIL + 500));
    }
  }
  const { files } = await prFiles(gh, repo, pr.number);
  const user = [
    'Diagnose this failed CI run.',
    wrapUntrusted('untrusted_pr', `Title: ${pr.title}\n\nChanged files:\n${files.slice(0, 200).map((f) => f.filename).join('\n')}`),
    ...logs,
  ].join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  const { system, schema, version: skillVersion, model } = await loadSkill('ci-diagnose');
  let out;
  try {
    out = await callModel({ model, system, user, schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
    return { lines: [heading, `Skipped: ${why}. Re-run this job to diagnose.`, '', `\`${err.message.slice(0, 500)}\``] };
  }
  const errors = validate(schema, out);
  if (errors.length) return { lines: [heading, 'Invalid output (nothing posted):', '', ...errors.map((x) => `- ${x}`)] };

  // One diagnosis comment per PR, updated in place: the marker prefix matches any commit's.
  await upsertComment(DIAGNOSIS_MARKER, renderDiagnosis(out, { sha, runs, skillVersion, model }));
  return {
    lines: [
      heading,
      '| Skill | Version | Model | Input hash | Failed runs | Jobs read | Category | Confidence |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      `| ci-diagnose | ${skillVersion} | ${model} | \`${inputHash}\` | ${runs.length} | ${logs.length} | ${out.category} | ${out.confidence} |`,
    ],
  };
}
