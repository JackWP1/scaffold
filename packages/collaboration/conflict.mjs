// conflict-check (PLAN.md section 8, slice 5), with the client and model injected so tests can fake them.
// Find (deterministic): Actions shortlists overlapping work. Judge (AI): one tool-less model call on the
// shortlist only. Flag: scaffold:conflict on the ticket and one conflict comment linking every ticket
// involved. Imports only core.
import { createHash } from 'node:crypto';
import { wrapUntrusted, escapeForComment as e } from '../core/lib/text.mjs';
import { validate } from '../core/lib/validate.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { readRepoFile } from '../core/lib/config.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { MARKER, setGates, manualStates, PR_GATES } from '../core/lib/status.mjs';
import { prFiles, linkedIssues, pathsOf } from '../core/lib/pr.mjs';
import { CONFLICT, CONFLICT_RESOLVED, conflictState } from '../core/lib/conflicts.mjs';

export const CONFLICT_MARKER = '<!-- scaffold:conflict -->';
// Records the clean or flagged result of check 2 for a PR head, which merge order reads.
export const CHECK2_MARKER = '<!-- scaffold:conflict-check-2';
// The plan package's marked comment and data (handover contract, PLAN.md section 5): read, never imported.
const PLAN_MARKER = '<!-- scaffold:plan -->';
const PLAN_DATA = /<!-- scaffold:plan-data ([A-Za-z0-9+/=]+) -->/;
const IN_FLIGHT = ['scaffold:planned', 'scaffold:plan-approved'];
const MAX_CANDIDATES = 10;
const heading = '### SCAFFOLD conflict-check';

const planData = (body) => {
  try {
    return JSON.parse(Buffer.from(body.match(PLAN_DATA)[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

// A path or glob as a directory-ish prefix: everything before the first wildcard.
const prefix = (p) => p.replace(/^\.?\//, '').split(/[*?[{]/)[0];
// Two path lists overlap when a prefix of one contains a prefix of the other (or they're the same file).
export function pathsOverlap(a, b) {
  const pa = a.map(prefix).filter(Boolean);
  const pb = b.map(prefix).filter(Boolean);
  const within = (x, y) => x === y || (y.endsWith('/') ? x.startsWith(y) : x.startsWith(`${y}/`));
  return pa.filter((x) => pb.some((y) => within(x, y) || within(y, x)));
}

export const specRefs = (text) => [...new Set([...String(text ?? '').matchAll(/\bdocs\/spec\/[\w./-]+/g)].map(([m]) => m.replace(/[.)]+$/, '')))];

// The ticket's affected paths and spec references, from its plan (or the issue when there's no plan).
async function ticketScope(gh, repo, number) {
  const issue = await gh.get(`/repos/${repo}/issues/${number}`);
  const plan = await issueSteps(gh, repo, number, []).findComment(PLAN_MARKER);
  const data = plan ? planData(plan.body) : null;
  const paths = [...(data?.affected_paths ?? []), ...(data?.subtasks ?? []).flatMap((t) => t.affected_paths ?? [])];
  return { issue, plan, data, paths: [...new Set(paths)], spec: specRefs(`${issue.body ?? ''}\n${plan?.body ?? ''}`) };
}

async function openInFlight(gh, repo, exclude) {
  const found = new Map();
  for (const label of IN_FLIGHT) {
    for await (const page of gh.pages(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`)) {
      for (const i of page) if (!i.pull_request && i.number !== exclude) found.set(i.number, i);
    }
  }
  return [...found.values()];
}

async function specText(gh, repo, refs, ref) {
  const parts = [];
  for (const path of refs.slice(0, 5)) {
    const text = await readRepoFile(gh, repo, path, ref).catch(() => null);
    if (text) parts.push(`## ${path}\n\n${text.slice(0, 4000)}`);
  }
  return parts.join('\n\n');
}

// Shared judge-and-flag step. `work` describes the ticket or PR; `candidates` are [{ number, why, text }].
async function judge(gh, repo, { issue, work, candidates, spec, config, loadSkill, callModel, check, prNumber, sha }) {
  const steps = issueSteps(gh, repo, issue, (await gh.get(`/repos/${repo}/issues/${issue}`)).labels.map((l) => l.name));
  const updateStatus = async (row, next) => steps.upsertStatus(setGates((await steps.findComment(MARKER))?.body, { ...manualStates(config), Conflicts: row }, next));
  const audit = (outcome, extra = []) => [heading, `Check ${check} for #${issue}${prNumber ? ` (PR #${prNumber})` : ''}: ${outcome}`, ...extra];
  const record = async (row) => {
    if (!prNumber) return;
    const pr = issueSteps(gh, repo, prNumber, []);
    await pr.upsertComment(CHECK2_MARKER, `${CHECK2_MARKER} ${sha} ${row.startsWith('✅') ? 'clean' : 'flagged'} -->\nconflict-check 2 for ${sha.slice(0, 7)}: ${row}`);
    await pr.upsertStatus(setGates((await pr.findComment(MARKER))?.body, { Conflicts: row }, undefined, PR_GATES));
  };

  if (!candidates.length) {
    const row = `✅ no overlapping work (check ${check})`;
    await updateStatus(row);
    await record(row);
    return { lines: audit('nothing overlaps: no model call') };
  }
  const user = [
    `Check this ${check === 1 ? 'ticket, before implementation,' : 'approved PR, before it gets a merge position,'} against the shortlisted work.`,
    wrapUntrusted('untrusted_work', work),
    wrapUntrusted('untrusted_candidates', candidates.map((c) => `### #${c.number} (shortlisted: ${c.why})\n\n${c.text}`).join('\n\n'), 40_000),
    spec ? wrapUntrusted('untrusted_spec', spec) : '',
    await readRepoFile(gh, repo, 'PRECEDENTS.md').then((t) => (t ? wrapUntrusted('untrusted_precedents', t) : '')).catch(() => ''),
  ].filter(Boolean).join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);
  const { system, schema, version, model } = await loadSkill('conflict-check');
  let out;
  try {
    out = await callModel({ model, system, user, schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
    await updateStatus(`⚠️ conflict-check ${check} skipped: ${why}`, 'a member re-runs the conflict-check job.');
    return { lines: audit(`skipped: ${why}`, ['', `\`${err.message.slice(0, 500)}\``]) };
  }
  const errors = validate(schema, out);
  if (errors.length) return { lines: audit('invalid output, nothing applied', errors.map((x) => `- ${x}`)) };
  // Only the shortlisted numbers count: the model can't flag work it wasn't shown.
  const known = new Set(candidates.map((c) => c.number));
  const findings = out.findings.map((f) => ({ ...f, with: f.with.filter((n) => known.has(n)) })).filter((f) => f.with.length);
  const meta = `<sub>conflict-check v${version} · ${model} · input \`${inputHash}\` · AI-generated: check before acting</sub>`;
  if (!findings.length) {
    const row = `✅ no conflicts (check ${check}, ${candidates.length} overlap${candidates.length === 1 ? '' : 's'} judged)`;
    await updateStatus(row);
    await record(row);
    return { lines: audit(`${candidates.length} candidates, no findings`) };
  }

  const involved = [...new Set(findings.flatMap((f) => f.with))];
  await steps.upsertComment(CONFLICT_MARKER, [
    CONFLICT_MARKER,
    `### SCAFFOLD conflict (check ${check}${prNumber ? `, PR #${prNumber}` : ''})`,
    '',
    `Involves ${involved.map((n) => `#${n}`).join(', ')}. ${e(out.summary)}`,
    '',
    ...findings.map((f) => `- **${f.kind}** with ${f.with.map((n) => `#${n}`).join(', ')}${f.spec.length ? ` (${f.spec.map((s) => `\`${e(s)}\``).join(', ')})` : ''}: ${e(f.explanation)}`),
    '',
    'Implementation and merging are blocked until it\'s resolved. The flow lead and the owners of the tickets involved choose: no real conflict (a listed approver applies `scaffold:conflict-resolved`), sequence (mark this as blocked by the other ticket), replan, change the requirement, or drop or merge tickets. React 👎 if this is a false alarm: the usage report counts it.',
    '',
    meta,
  ].join('\n'));
  await steps.setLabels([CONFLICT], [CONFLICT_RESOLVED]);
  const row = `🚧 conflict with ${involved.map((n) => `#${n}`).join(', ')} (check ${check})`;
  await updateStatus(row, 'the flow lead and ticket owners resolve the conflict; a listed approver applies `scaffold:conflict-resolved` if it isn\'t real.');
  await record(row);
  return { lines: audit(`${findings.length} finding${findings.length === 1 ? '' : 's'}: flagged`, [`Involves ${involved.map((n) => `#${n}`).join(', ')}; model ${model}, input \`${inputHash}\``]) };
}

const describe = (issue, plan, data) => [
  `Title: ${issue.title}`,
  '',
  issue.body ?? '',
  ...(data ? ['', `Plan approach: ${data.approach}`, `Affected paths: ${(data.affected_paths ?? []).join(', ')}`] : plan ? ['', plan.body] : []),
].join('\n');

// Check 1: after scaffold:plan-approved, before implementation. Event: the human's label.
export async function runCheck1(gh, repo, { event, config, loadSkill, callModel }) {
  if (event.issue?.pull_request) return { skip: 'pull request' };
  if (event.action !== 'labeled' || event.label?.name !== 'scaffold:plan-approved') return { skip: 'not scaffold:plan-approved being applied' };
  const number = event.issue.number;
  const me = await ticketScope(gh, repo, number);
  if (!me.issue.labels.some((l) => l.name === 'scaffold:plan-approved')) return { skip: 'the plan gate removed the approval' };
  const candidates = [];
  for (const other of (await openInFlight(gh, repo, number)).slice(0, 100)) {
    const them = await ticketScope(gh, repo, other.number);
    const paths = pathsOverlap(me.paths, them.paths);
    const spec = me.spec.filter((s) => them.spec.includes(s));
    if (!paths.length && !spec.length) continue;
    candidates.push({ number: other.number, why: [paths.length ? `affected paths ${paths.slice(0, 5).join(', ')}` : '', spec.length ? `spec ${spec.join(', ')}` : ''].filter(Boolean).join('; '), text: describe(them.issue, them.plan, them.data) });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return judge(gh, repo, {
    issue: number, work: describe(me.issue, me.plan, me.data), candidates, check: 1, config, loadSkill, callModel,
    spec: await specText(gh, repo, me.spec),
  });
}

const reviewDecision = async (gh, repo, number) => {
  const [owner, name] = repo.split('/');
  const data = await gh.graphql('query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision } } }', { owner, name, number });
  return data.repository.pullRequest.reviewDecision;
};

// Every path a PR touches, a rename's old name included.
const touchedBy = async (gh, repo, number) => [...new Set((await prFiles(gh, repo, number)).files.flatMap(pathsOf))];

// PRs merged into the base branch since this PR branched that touch its files: one candidate each.
async function mergedSince(gh, repo, pr, mine) {
  const { merge_base_commit: mergeBase } = await gh.get(`/repos/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`).catch(() => ({}));
  if (!mergeBase?.sha) return [];
  const { commits = [], files = [] } = await gh.get(`/repos/${repo}/compare/${mergeBase.sha}...${encodeURIComponent(pr.base.ref)}`).catch(() => ({}));
  if (!files.some((f) => pathsOf(f).some((p) => mine.includes(p)))) return [];
  const found = new Map();
  for (const c of commits.slice(-30)) {
    const prs = await gh.get(`/repos/${repo}/commits/${c.sha}/pulls`).catch(() => []);
    for (const merged of prs.filter((p) => p.merged_at && p.number !== pr.number)) {
      if (found.has(merged.number) || found.size >= MAX_CANDIDATES) continue;
      const theirs = await touchedBy(gh, repo, merged.number);
      const shared = mine.filter((f) => theirs.includes(f));
      if (shared.length) found.set(merged.number, { number: linkedIssues(merged.body)[0] ?? merged.number, why: `merged PR #${merged.number} changed ${shared.slice(0, 5).join(', ')} since this PR branched`, text: `Merged PR #${merged.number}: ${merged.title}\n\n${merged.body ?? ''}\n\nChanged files: ${theirs.slice(0, 100).join(', ')}` });
    }
  }
  return [...found.values()];
}

// Check 2: after the PR's required reviews approve it, before it gets a merge position; again on each push
// while it stays approved (repos that don't dismiss approvals on push). Compares it with other approved open
// PRs and with PRs merged into the base branch since it branched, on the same files (renames included).
export async function runCheck2(gh, repo, { event, config, loadSkill, callModel }) {
  const pr = event.pull_request;
  const approving = event.review?.state?.toLowerCase() === 'approved';
  if (!pr || (!approving && event.action !== 'synchronize')) return { skip: 'not an approving review or a push' };
  if (await reviewDecision(gh, repo, pr.number) !== 'APPROVED') return { skip: 'the PR\'s required reviews haven\'t approved it yet' };
  const issue = linkedIssues(pr.body)[0];
  if (!issue) return { skip: 'the PR doesn\'t link an issue' };
  const mine = await touchedBy(gh, repo, pr.number);
  const candidates = [];
  for await (const page of gh.pages(`/repos/${repo}/pulls?state=open`)) {
    for (const other of page) {
      if (other.number === pr.number || other.draft || candidates.length >= MAX_CANDIDATES) continue;
      if (await reviewDecision(gh, repo, other.number) !== 'APPROVED') continue;
      const theirs = await touchedBy(gh, repo, other.number);
      const shared = mine.filter((f) => theirs.includes(f));
      if (!shared.length) continue;
      const otherIssue = linkedIssues(other.body)[0];
      candidates.push({ number: otherIssue ?? other.number, why: `PR #${other.number} also changes ${shared.slice(0, 5).join(', ')}`, text: `PR #${other.number}: ${other.title}\n\n${other.body ?? ''}\n\nChanged files: ${theirs.slice(0, 100).join(', ')}` });
    }
  }
  for (const m of await mergedSince(gh, repo, pr, mine)) if (candidates.length < MAX_CANDIDATES && !candidates.some((c) => c.number === m.number)) candidates.push(m);
  const work = `PR #${pr.number} for #${issue}: ${pr.title}\n\n${pr.body ?? ''}\n\nChanged files: ${mine.slice(0, 200).join(', ')}`;
  return judge(gh, repo, {
    issue, work, candidates, check: 2, config, loadSkill, callModel, prNumber: pr.number, sha: pr.head.sha,
    spec: await specText(gh, repo, specRefs(`${pr.body ?? ''}\n${mine.join('\n')}`), pr.base.sha),
  });
}

// scaffold:conflict-resolved applied or removed by hand: re-checks the timeline and shows the result.
export async function runResolve(gh, repo, { event, config }) {
  if (!['labeled', 'unlabeled'].includes(event.action) || event.label?.name !== CONFLICT_RESOLVED) return { skip: 'not scaffold:conflict-resolved' };
  const number = event.issue.number;
  const labels = (await gh.get(`/repos/${repo}/issues/${number}`)).labels.map((l) => l.name);
  const steps = issueSteps(gh, repo, number, labels);
  const state = conflictState({ events: await steps.events(), approvers: config.approvers });
  const update = async (row, next) => steps.upsertStatus(setGates((await steps.findComment(MARKER))?.body, { ...manualStates(config), Conflicts: row }, next));
  if (!state.flaggedAt) return { skip: 'no conflict was flagged' };
  if (state.open) {
    if (event.action === 'labeled') await steps.setLabels([], [CONFLICT_RESOLVED]);
    await update(`🚧 still open: ${state.reason}`, 'a listed approver applies `scaffold:conflict-resolved` once it\'s resolved.');
    return { lines: [heading, `#${number}: still open (${state.reason})`] };
  }
  await steps.setLabels([], [CONFLICT]);
  await update(`✅ resolved by \`${state.resolvedBy}\``);
  return { lines: [heading, `#${number}: resolved by ${state.resolvedBy}`] };
}
