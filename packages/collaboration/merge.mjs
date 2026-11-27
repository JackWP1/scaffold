// Merge order and the merge-order check (PLAN.md section 8), with the client injected so tests can fake it.
// No model call. After conflict-check 2 passes, each approved PR without an open conflict gets a position:
//   1. PRs whose ticket blocks other tickets ("Blocked by #n" in their description) first;
//   2. stacked PRs bottom-up;
//   3. higher priority (priority:* on the linked issue);
//   4. earliest approval of the current head.
// In the merge queue, `merge-order` fails if a PR jumps the order or has an open conflict, unless the flow
// lead overrode the order (never a conflict).
import { issueSteps } from '../core/lib/issue.mjs';
import { linkedIssues } from '../core/lib/pr.mjs';
import { conflictState } from '../core/lib/conflicts.mjs';
import { MARKER, setGates, PR_GATES } from '../core/lib/status.mjs';
import { escapeForComment as e } from '../core/lib/text.mjs';
import { CHECK2_MARKER } from './conflict.mjs';

export const ORDER_OVERRIDE = 'scaffold:order-override';
// Records each PR's current position; rewritten (so its time moves) only when the position changes.
export const POSITION_MARKER = '<!-- scaffold:merge-position';
export const OVERRIDE_COMMAND = /^\/order-override(?:\s+([\s\S]*))?$/;
const PRIORITY = { 'priority:high': 0, 'priority:medium': 1, 'priority:low': 2 };

async function graphql(gh, repo, query, variables = {}) {
  const [owner, name] = repo.split('/');
  return gh.graphql(query, { owner, name, ...variables });
}

const reviewDecision = async (gh, repo, number) => (await graphql(gh, repo, 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewDecision } } }', { number })).repository.pullRequest.reviewDecision;

// Issues an issue blocks: open issues whose description says "Blocked by #n" (or "Depends on #n").
export const blockersIn = (body) => [...String(body ?? '').matchAll(/\b(?:blocked by|depends on)\s+#(\d+)/gi)].map(([, n]) => Number(n));

// Candidates for a position, with what ordering needs. `config.approvers` checks conflict resolutions.
export async function orderable(gh, repo, config) {
  const prs = [];
  for await (const page of gh.pages(`/repos/${repo}/pulls?state=open`)) prs.push(...page.filter((p) => !p.draft));
  const blocks = new Map();
  for await (const page of gh.pages(`/repos/${repo}/issues?state=open`)) {
    for (const i of page) if (!i.pull_request) for (const n of blockersIn(i.body)) blocks.set(n, (blocks.get(n) ?? 0) + 1);
  }
  const out = [];
  const skipped = [];
  for (const pr of prs) {
    const issue = linkedIssues(pr.body)[0];
    const why = (reason) => skipped.push({ number: pr.number, reason });
    if (!issue) { why('no linked issue'); continue; }
    if (await reviewDecision(gh, repo, pr.number) !== 'APPROVED') { why('not approved'); continue; }
    const prSteps = issueSteps(gh, repo, pr.number, []);
    const check2 = await prSteps.findComment(CHECK2_MARKER);
    if (!check2?.body.startsWith(`${CHECK2_MARKER} ${pr.head.sha} clean -->`)) { why('conflict-check 2 hasn\'t passed on its latest commit'); continue; }
    const meta = await gh.get(`/repos/${repo}/issues/${issue}`);
    const steps = issueSteps(gh, repo, issue, meta.labels.map((l) => l.name));
    if (conflictState({ events: await steps.events(), approvers: config.approvers }).open) { why(`#${issue} has an open conflict`); continue; }
    const reviews = [];
    for await (const page of gh.pages(`/repos/${repo}/pulls/${pr.number}/reviews`)) reviews.push(...page);
    const approvedAt = reviews.filter((r) => r.state === 'APPROVED' && r.commit_id === pr.head.sha).map((r) => r.submitted_at).sort()[0] ?? check2.updated_at;
    // The position's own record moves whenever the position does; an override must come after both.
    const position = await prSteps.findComment(POSITION_MARKER);
    out.push({
      number: pr.number, issue, pr,
      blocks: blocks.get(issue) ?? 0,
      priority: Math.min(3, ...meta.labels.map((l) => PRIORITY[l.name] ?? 3)),
      approvedAt,
      positionedAt: [check2.updated_at, position?.updated_at].filter(Boolean).sort().at(-1),
      recordedPosition: Number(position?.body.match(/position (\d+) of/)?.[1] ?? 0),
    });
  }
  return { ordered: sortOrder(out), skipped };
}

// Pure. Blockers first, then priority, then earliest approval; a stacked PR always follows the PR whose
// branch it's based on (bottom-up), wherever that one lands.
export function sortOrder(items) {
  const rank = [...items].sort((a, b) => (b.blocks > 0) - (a.blocks > 0) || a.priority - b.priority || Date.parse(a.approvedAt) - Date.parse(b.approvedAt) || a.number - b.number);
  const byHead = new Map(items.map((i) => [i.pr.head.ref, i]));
  const placed = new Set();
  const out = [];
  const place = (item, seen = new Set()) => {
    if (placed.has(item.number) || seen.has(item.number)) return;
    seen.add(item.number);
    const below = byHead.get(item.pr.base.ref);
    if (below) place(below, seen);
    placed.add(item.number);
    out.push(item);
  };
  for (const item of rank) place(item);
  return out;
}

// Writes each ordered PR's Merge order row.
export async function writePositions(gh, repo, { ordered, skipped = [] }) {
  for (const [i, item] of ordered.entries()) {
    const steps = issueSteps(gh, repo, item.number, []);
    if (item.recordedPosition !== i + 1) {
      const posted = await steps.upsertComment(POSITION_MARKER, `${POSITION_MARKER} -->\nSCAFFOLD merge position ${i + 1} of ${ordered.length}.`);
      item.positionedAt = posted?.updated_at ?? new Date().toISOString();
      item.recordedPosition = i + 1;
    }
    const next = i === 0 ? 'a developer adds this PR to the merge queue: it\'s next.' : `wait for ${ordered.slice(0, i).map((o) => `#${o.number}`).join(', ')} to merge or enter the merge queue first.`;
    await steps.upsertStatus(setGates((await steps.findComment(MARKER))?.body, { 'Merge order': `${i + 1} of ${ordered.length}` }, next, PR_GATES));
  }
  for (const s of skipped.filter((x) => x.reason.includes('conflict'))) {
    const steps = issueSteps(gh, repo, s.number, []);
    await steps.upsertStatus(setGates((await steps.findComment(MARKER))?.body, { 'Merge order': `⛔ no position: ${s.reason}` }, undefined, PR_GATES));
  }
}

// PRs already in the merge queue ahead of PR `number` (GraphQL; REST has no merge queue).
async function queueAhead(gh, repo, base, number) {
  const data = await graphql(gh, repo, 'query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { entries(first: 100) { nodes { position pullRequest { number } } } } } }', { branch: base });
  const entries = data.repository.mergeQueue?.entries.nodes ?? [];
  const mine = entries.find((n) => n.pullRequest.number === number);
  return new Set(entries.filter((n) => mine && n.position < mine.position).map((n) => n.pullRequest.number));
}

// A valid override: scaffold:order-override and a `/order-override <reason>` comment, both by the flow lead,
// after the PR got its position (conflict-check 2 on its latest commit, which a push re-runs).
async function override(gh, repo, item, config) {
  if (!config.flow_lead) return null;
  const lead = config.flow_lead.toLowerCase();
  const steps = issueSteps(gh, repo, item.number, []);
  const after = (at) => Date.parse(at) > Date.parse(item.positionedAt);
  const events = await steps.events();
  const last = events.filter((x) => ['labeled', 'unlabeled'].includes(x.event) && x.label?.name === ORDER_OVERRIDE).at(-1);
  if (last?.event !== 'labeled' || last.actor?.login?.toLowerCase() !== lead || !after(last.created_at)) return null;
  let reason = null;
  for await (const page of gh.pages(`/repos/${repo}/issues/${item.number}/comments`)) {
    for (const c of page) {
      const m = c.body?.trim().match(OVERRIDE_COMMAND);
      if (m?.[1]?.trim() && c.user?.login?.toLowerCase() === lead && after(c.created_at)) reason = m[1].trim();
    }
  }
  return reason ? { by: last.actor.login, reason } : null;
}

// The merge-order check, on merge_group. Returns { ok, outcome, details }.
export async function mergeOrderCheck(gh, repo, { event, config }) {
  const group = event.merge_group;
  const m = group?.head_ref?.match(/\/pr-(\d+)-[0-9a-f]+$/);
  if (!m) return { ok: false, outcome: `can't tell which PR this merge group is for (\`${e(group?.head_ref ?? '')}\`)`, details: [] };
  const number = Number(m[1]);
  const { ordered, skipped } = await orderable(gh, repo, config);
  const mine = ordered.findIndex((o) => o.number === number);
  if (mine < 0) {
    const reason = skipped.find((s) => s.number === number)?.reason ?? 'not an open, approved PR';
    return { ok: false, outcome: `PR #${number} has no merge position: ${reason}`, details: [] };
  }
  const ahead = await queueAhead(gh, repo, group.base_ref.replace(/^refs\/heads\//, ''), number);
  const jumped = ordered.slice(0, mine).filter((o) => !ahead.has(o.number));
  // Positions are written first: a position that has just changed makes an older override stale.
  await writePositions(gh, repo, { ordered, skipped });
  if (!jumped.length) return { ok: true, outcome: `PR #${number} is ${mine + 1} of ${ordered.length} in the merge order`, details: [] };
  const ok = await override(gh, repo, ordered[mine], config);
  if (ok) return { ok: true, outcome: `PR #${number} goes out of order: overridden by \`${ok.by}\`: ${e(ok.reason).slice(0, 200)}`, details: [] };
  return {
    ok: false,
    outcome: `PR #${number} is ${mine + 1} of ${ordered.length}: ${jumped.map((o) => `#${o.number}`).join(', ')} must merge or enter the queue first`,
    details: ['The flow lead can let it go out of order: comment `/order-override <reason>` and apply `scaffold:order-override` (never for an open conflict).'],
  };
}

// After conflict-check 2: recompute and write every position.
export async function refreshOrder(gh, repo, { config }) {
  const order = await orderable(gh, repo, config);
  await writePositions(gh, repo, order);
  return { lines: ['### SCAFFOLD merge order', ...order.ordered.map((o, i) => `${i + 1}. #${o.number} (#${o.issue})`), ...order.skipped.map((s) => `- #${s.number}: ${s.reason}`)] };
}

export const isOverrideCommand = (body) => OVERRIDE_COMMAND.test(String(body ?? '').trim());
