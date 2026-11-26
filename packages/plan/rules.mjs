// Deterministic plan checks (PLAN.md section 6): Actions code decides, not the model.
import { validate } from '../core/lib/validate.mjs';
import { checkApproval, commentHash } from '../core/lib/approval.mjs';

export const PLAN_MARKER = '<!-- scaffold:plan -->';
export const planHash = commentHash;

const DATA = /<!-- scaffold:plan-data ([A-Za-z0-9+/=]+) -->/;

// The validated plan travels in the plan comment so the gate never calls the model.
export const encodePlan = (plan) => `<!-- scaffold:plan-data ${Buffer.from(JSON.stringify(plan)).toString('base64')} -->`;

function rawPlan(body) {
  const m = body?.match(DATA);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function decodePlan(body, schema) {
  const plan = rawPlan(body);
  return plan && !validate(schema, plan).length ? plan : null;
}

// Plans made before Phase 1b could split into sub-tickets. They now fail the schema; the gate names why.
export const isSubTicketPlan = (body) => rawPlan(body)?.split === 'sub-tickets';

// Needs more than one stack of `maxStack` PRs: the ticket goes back to triage (PLAN.md section 6).
export const isTooBig = (plan, maxStack) => plan.split === 'too-big' || (plan.split === 'stack' && plan.subtasks.length > maxStack);

const over = (e, limit) => e.files > limit.files || e.lines > limit.lines;
const fmt = (e) => `${e.files} files / ${e.lines} lines`;

// Problems that make a plan unapprovable as it stands. An empty list means it fits the size rules.
export function checkPlan(plan, limits, maxStack) {
  const problems = [];
  const ids = plan.subtasks.map((t) => t.id);
  if (plan.split === 'too-big') problems.push(`needs more than ${maxStack} PRs (\`max_stack_prs\`): back to triage`);
  else if (!plan.subtasks.length) problems.push('the plan has no sub-tasks');
  if (plan.split === 'none' && over(plan.estimate, limits.soft)) {
    problems.push(`estimate ${fmt(plan.estimate)} is over the soft limit (${fmt(limits.soft)}) but the work is not split`);
  }
  if (plan.split === 'stack') {
    if (plan.subtasks.length < 2) problems.push('a stack needs at least 2 PRs');
    if (plan.subtasks.length > maxStack) problems.push(`a stack of ${plan.subtasks.length} PRs is more than ${maxStack} (\`max_stack_prs\`): back to triage`);
    for (const t of plan.subtasks) {
      if (over(t.estimate, limits.soft)) problems.push(`sub-task ${t.id} (${fmt(t.estimate)}) is over the soft limit`);
    }
  }
  if (new Set(ids).size !== ids.length) problems.push('sub-task ids are not unique');
  plan.subtasks.forEach((t, i) => {
    for (const b of t.blocked_by) {
      if (!ids.slice(0, i).includes(b)) problems.push(`sub-task ${t.id} is blocked by ${b}, which is not an earlier sub-task`);
    }
  });
  return problems;
}

// The planned → approved gate (PLAN.md section 6): core's timeline approval check on the plan comment,
// then the plan's own rules. `subTickets` is set when the comment holds a pre-Phase 1b sub-ticket plan.
export function evaluateApproval({ events, author, approvers, planComment, plan, limits, maxStack, subTickets = false }) {
  const approval = checkApproval({
    events, label: 'scaffold:plan-approved', author, approvers, comment: planComment, what: 'plan', missing: 'there is no plan: comment `/plan` first',
  });
  if (!approval.ok) return approval;
  const fail = (reason) => ({ ok: false, reason, approver: approval.approver, at: approval.at, eventId: approval.eventId });
  if (!plan) return fail(subTickets ? 'sub-tickets removed: run `/plan` again' : 'the plan comment\'s data is missing or invalid: comment `/plan` again');
  const problems = checkPlan(plan, limits, maxStack);
  if (problems.length) return fail(`the plan fails the size rules: ${problems.join('; ')}`);
  return approval;
}
