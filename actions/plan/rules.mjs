// Deterministic plan checks (PLAN.md section 6): Actions code decides, not the model.
import { createHash } from 'node:crypto';
import { validate } from '../lib/validate.mjs';

export const PLAN_MARKER = '<!-- scaffold:plan -->';
export const MAX_SUB_TICKETS = 5;

const DATA = /<!-- scaffold:plan-data ([A-Za-z0-9+/=]+) -->/;

// The validated plan travels in the plan comment so the gate never calls the model.
export const encodePlan = (plan) => `<!-- scaffold:plan-data ${Buffer.from(JSON.stringify(plan)).toString('base64')} -->`;

export function decodePlan(body, schema) {
  const m = body?.match(DATA);
  if (!m) return null;
  try {
    const plan = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return validate(schema, plan).length ? null : plan;
  } catch {
    return null;
  }
}

export const planHash = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);

const over = (e, limit) => e.files > limit.files || e.lines > limit.lines;
const fmt = (e) => `${e.files} files / ${e.lines} lines`;

// Problems that make a plan unapprovable as it stands. An empty list means it fits the size rules.
export function checkPlan(plan, limits) {
  const problems = [];
  const ids = plan.subtasks.map((t) => t.id);
  if (plan.split === 'too-big') problems.push(`needs more than ${MAX_SUB_TICKETS} sub-tickets: replan or split it in Jira`);
  if (plan.split === 'none' && over(plan.estimate, limits.soft)) {
    problems.push(`estimate ${fmt(plan.estimate)} is over the soft limit (${fmt(limits.soft)}) but the work is not split`);
  }
  if (plan.split === 'stack' || plan.split === 'sub-tickets') {
    if (plan.subtasks.length < 2) problems.push(`a ${plan.split} split needs at least 2 sub-tasks`);
    for (const t of plan.subtasks) {
      if (over(t.estimate, limits.soft)) problems.push(`sub-task ${t.id} (${fmt(t.estimate)}) is over the soft limit`);
    }
  }
  if (plan.split === 'sub-tickets' && plan.subtasks.length > MAX_SUB_TICKETS) {
    problems.push(`${plan.subtasks.length} sub-tickets is more than ${MAX_SUB_TICKETS}`);
  }
  if (new Set(ids).size !== ids.length) problems.push('sub-task ids are not unique');
  plan.subtasks.forEach((t, i) => {
    for (const b of t.blocked_by) {
      if (!ids.slice(0, i).includes(b)) problems.push(`sub-task ${t.id} is blocked by ${b}, which is not an earlier sub-task`);
    }
  });
  return problems;
}

// The planned → approved gate (PLAN.md section 6). Reads the issue timeline, not just the label:
// the latest scaffold:plan-approved must be applied by a listed approver who isn't the issue author
// or a bot, after the plan comment's last change, on a plan that passes checkPlan.
export function evaluateApproval({ events, author, approvers, planComment, plan, limits }) {
  const applied = events.filter((e) => e.event === 'labeled' && e.label?.name === 'scaffold:plan-approved').at(-1);
  if (!applied) return { ok: false, reason: '`scaffold:plan-approved` was not applied' };
  const actor = applied.actor ?? {};
  const fail = (reason) => ({ ok: false, reason, approver: actor.login, at: applied.created_at });
  if (actor.type !== 'User') return fail('applied by a bot, not a person');
  if (actor.login?.toLowerCase() === author?.toLowerCase()) return fail('the issue author can\'t approve their own issue');
  if (!approvers.includes(actor.login?.toLowerCase())) return fail(`\`${actor.login}\` is not a listed approver in \`.github/scaffold.yml\``);
  if (!planComment) return fail('there is no plan: comment `/plan` first');
  if (Date.parse(planComment.updated_at) > Date.parse(applied.created_at)) return fail('the plan changed after it was approved: review it and apply the label again');
  if (!plan) return fail('the plan comment\'s data is missing or invalid: comment `/plan` again');
  const problems = checkPlan(plan, limits);
  if (problems.length) return fail(`the plan fails the size rules: ${problems.join('; ')}`);
  return { ok: true, approver: actor.login, at: applied.created_at, hash: planHash(planComment.body) };
}
