// Conflict flags (PLAN.md section 8): shared by the collaboration package, which flags, and the gates that
// must hold while a flag is open (implement's plan gate, collaboration's merge-order check).
// Labels alone aren't protection: the state comes from the issue's timeline.
import { checkApproval } from './approval.mjs';

export const CONFLICT = 'scaffold:conflict';
export const CONFLICT_RESOLVED = 'scaffold:conflict-resolved';
const BOT = 'github-actions[bot]';

// { open, flaggedAt?, resolvedBy?, reason? }. A conflict is open from SCAFFOLD's latest scaffold:conflict
// until a listed approver applies scaffold:conflict-resolved after it (and doesn't remove it again).
// Removing scaffold:conflict by hand doesn't clear it.
export function conflictState({ events, approvers }) {
  const flag = events.filter((e) => e.event === 'labeled' && e.label?.name === CONFLICT && e.actor?.login === BOT).at(-1);
  if (!flag) return { open: false };
  const resolution = checkApproval({
    events: events.filter((e) => Date.parse(e.created_at) >= Date.parse(flag.created_at)),
    label: CONFLICT_RESOLVED,
    approvers,
    comment: { body: '', updated_at: flag.created_at },
    what: 'conflict flag',
  });
  if (resolution.ok) return { open: false, flaggedAt: flag.created_at, resolvedBy: resolution.approver };
  return { open: true, flaggedAt: flag.created_at, reason: resolution.reason };
}
