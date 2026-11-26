// Weekly usage report (PLAN.md section 7), with the client injected so tests can fake it.
// Runs per job come from the Actions API; skill and gate outcomes from the repo's issue events, which
// record every label SCAFFOLD or a human applied. Posted as a comment on one standing report issue.
import { stageOn, PACKAGES, RELEASED } from '../../lib/config.mjs';

export const REPORT_MARKER = '<!-- scaffold:usage-report -->';
const BOT = 'github-actions[bot]';
const CALLER = '.github/workflows/scaffold.yml';
const MAX_RUNS = 300;
const DAY = 86_400_000;

// Caller job name (e.g. `plan / plan (12, 345)`) → the skill it runs, if any.
const SKILLS = { 'triage / triage': 'triage', 'plan / plan': 'task-decomposer' };

async function callerRuns(gh, repo, since) {
  const runs = [];
  for (let page = 1; runs.length < MAX_RUNS; page++) {
    const { workflow_runs: batch = [] } = await gh.get(`/repos/${repo}/actions/runs?created=%3E%3D${since.slice(0, 10)}&per_page=100&page=${page}`);
    runs.push(...batch.filter((r) => r.path === CALLER && r.created_at >= since));
    if (batch.length < 100) break;
  }
  return runs.slice(0, MAX_RUNS);
}

// Issue events since `since`, oldest first. The endpoint lists newest first.
async function issueEvents(gh, repo, since) {
  const all = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/events`)) {
    const recent = page.filter((e) => e.created_at >= since);
    all.push(...recent);
    if (recent.length < page.length) break;
  }
  return all.reverse();
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Pure: turns runs, jobs and issue events into report numbers. `jobs` maps run id → its jobs.
export function summarise({ runs, jobs, events }) {
  const perJob = {};
  for (const run of runs) {
    for (const j of jobs[run.id] ?? []) {
      if (j.conclusion === 'skipped') continue;
      const name = j.name.replace(/ \(.*\)$/, '');
      perJob[name] ??= { runs: 0, failed: 0 };
      perJob[name].runs++;
      if (j.conclusion === 'failure') perJob[name].failed++;
    }
  }
  const byBot = (e, event, label) => e.event === event && e.label?.name === label && e.actor?.login === BOT;
  const count = (event, label) => events.filter((e) => byBot(e, event, label)).length;

  // Plan approvals: a person applies the label; the gate removes it if the approval is invalid.
  const approvals = events.filter((e) => e.event === 'labeled' && e.label?.name === 'scaffold:plan-approved' && e.actor?.type === 'User');
  let passed = 0;
  const hours = [];
  for (const a of approvals) {
    const issue = a.issue?.number;
    const later = events.filter((e) => e.issue?.number === issue && e.created_at >= a.created_at && e.id !== a.id);
    if (later.some((e) => byBot(e, 'unlabeled', 'scaffold:plan-approved'))) continue;
    passed++;
    const planned = events.filter((e) => e.issue?.number === issue && byBot(e, 'labeled', 'scaffold:planned') && e.created_at <= a.created_at).at(-1);
    if (planned) hours.push((Date.parse(a.created_at) - Date.parse(planned.created_at)) / 3_600_000);
  }
  return {
    perJob,
    skills: Object.fromEntries(Object.entries(SKILLS).map(([job, skill]) => [skill, perJob[job]?.runs ?? 0])),
    triage: { ready: count('labeled', 'scaffold:ready'), needsInfo: count('labeled', 'scaffold:needs-info'), proposed: count('labeled', 'scaffold:proposed') },
    plan: { admitted: count('labeled', 'scaffold:planned'), tooBig: count('labeled', 'scaffold:too-big') },
    gate: { applied: approvals.length, passed, failed: approvals.length - passed, medianHours: median(hours) },
  };
}

export function renderReport({ from, to, numbers, config, configError }) {
  const n = numbers;
  const stageRows = PACKAGES.map((p) => {
    const state = configError ? '⛔ config invalid' : stageOn(config, p) ? 'on' : RELEASED.includes(p) ? '**off (manual)**' : 'off (not released)';
    return `| ${p} | ${state} |`;
  });
  return [
    REPORT_MARKER,
    `### SCAFFOLD usage: ${from} to ${to}`,
    '',
    '| Skill | Model calls (jobs run) |',
    '| --- | --- |',
    ...Object.entries(n.skills).map(([s, c]) => `| \`${s}\` | ${c} |`),
    '',
    '| Job | Runs | Failed |',
    '| --- | --- | --- |',
    ...(Object.keys(n.perJob).length ? Object.entries(n.perJob).sort().map(([j, c]) => `| ${j} | ${c.runs} | ${c.failed} |`) : ['| (none) | 0 | 0 |']),
    '',
    '| Outcome | Count |',
    '| --- | --- |',
    `| Triage: ready | ${n.triage.ready} |`,
    `| Triage: needs info | ${n.triage.needsInfo} |`,
    `| Triage: proposed (non-member) | ${n.triage.proposed} |`,
    `| Plan: admitted | ${n.plan.admitted} |`,
    `| Plan: too big, back to triage | ${n.plan.tooBig} |`,
    `| Plan gate: approvals applied | ${n.gate.applied} |`,
    `| Plan gate: passed | ${n.gate.passed} |`,
    `| Plan gate: failed or withdrawn | ${n.gate.failed} |`,
    `| Plan gate: median hours from admission to approval | ${n.gate.medianHours === null ? '-' : n.gate.medianHours.toFixed(1)} |`,
    '',
    '| Stage | State |',
    '| --- | --- |',
    ...stageRows,
    '',
    '<sub>Model cost and false positives are not measured yet: record false positives by replying to this comment.</sub>',
  ].join('\n');
}

// Builds the report for the week before `now` and posts it. Returns the report body.
export async function postReport(gh, repo, { now = new Date(), config, configError }) {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const runs = await callerRuns(gh, repo, since);
  const jobs = {};
  for (const run of runs) jobs[run.id] = (await gh.get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? [];
  const numbers = summarise({ runs, jobs, events: await issueEvents(gh, repo, since) });
  const body = renderReport({ from: since.slice(0, 10), to: now.toISOString().slice(0, 10), numbers, config, configError });

  let issue;
  for await (const page of gh.pages(`/repos/${repo}/issues?state=open&creator=${encodeURIComponent(BOT)}`)) {
    issue = page.find((i) => !i.pull_request && i.body?.startsWith(REPORT_MARKER));
    if (issue) break;
  }
  issue ??= await gh.post(`/repos/${repo}/issues`, {
    title: 'SCAFFOLD usage report',
    body: `${REPORT_MARKER}\nSCAFFOLD posts a usage report here every week (PLAN.md section 7). Keep this issue open.`,
  });
  await gh.post(`/repos/${repo}/issues/${issue.number}/comments`, { body });
  return body;
}
