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

const SCENARIOS_DATA = /<!-- scaffold:plan-scenarios ([0-9a-f]{16}) -->/;
// The hash of the approved scenarios comment the plan was made against, kept in the plan comment.
export const encodeScenarios = (hash) => `<!-- scaffold:plan-scenarios ${hash} -->`;
export const planScenarios = (body) => body?.match(SCENARIOS_DATA)?.[1] ?? null;

// Each approved scenario maps to a PR (PLAN.md section 2, Scenarios). One PR (`none`) may list a
// scenario under more than one step; a stack gives each scenario to exactly one PR.
function scenarioProblems(plan, ids) {
  const problems = [];
  const where = new Map(ids.map((id) => [id, []]));
  for (const t of plan.subtasks) {
    for (const s of t.scenarios ?? []) {
      if (!where.has(s)) problems.push(`sub-task ${t.id} maps ${s}, which is not an approved scenario`);
      else if (!where.get(s).includes(t.id)) where.get(s).push(t.id);
    }
  }
  for (const [id, tasks] of where) {
    if (!tasks.length) problems.push(`scenario ${id} is not mapped to ${plan.split === 'stack' ? 'a PR' : 'a sub-task'}`);
    else if (plan.split === 'stack' && tasks.length > 1) problems.push(`scenario ${id} is mapped to more than one PR (${tasks.join(', ')})`);
  }
  return problems;
}

// Problems that make a plan unapprovable as it stands. An empty list means it fits the size rules
// and maps every approved scenario (`scenarioIds`, empty when scenarios aren't required).
export function checkPlan(plan, limits, maxStack, scenarioIds = []) {
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
  if (plan.split !== 'too-big' && scenarioIds.length) problems.push(...scenarioProblems(plan, scenarioIds));
  return problems;
}

// The planned → approved gate (PLAN.md section 6): core's timeline approval check on the plan comment,
// then the plan's own rules. `subTickets` is set when the comment holds a pre-Phase 1b sub-ticket plan.
// `scenarios` is core's checkScenarios result when scenarios are required, else null: they must still
// be approved, be the ones the plan was made against, and each map to a PR.
export function evaluateApproval({ events, author, approvers, planComment, plan, limits, maxStack, subTickets = false, scenarios = null }) {
  const approval = checkApproval({
    events, label: 'scaffold:plan-approved', author, approvers, comment: planComment, what: 'plan', missing: 'there is no plan: comment `/plan` first',
  });
  if (!approval.ok) return approval;
  const fail = (reason) => ({ ok: false, reason, approver: approval.approver, at: approval.at, eventId: approval.eventId });
  if (!plan) return fail(subTickets ? 'sub-tickets removed: run `/plan` again' : 'the plan comment\'s data is missing or invalid: comment `/plan` again');
  if (scenarios && !scenarios.ok) return fail(`the scenarios aren't approved: ${scenarios.reason}`);
  if (scenarios && planScenarios(planComment.body) !== scenarios.hash) return fail('the scenarios changed since this plan was made: comment `/plan` again');
  const problems = checkPlan(plan, limits, maxStack, scenarios?.ids ?? []);
  if (problems.length) return fail(`the plan fails the size rules: ${problems.join('; ')}`);
  return approval;
}
