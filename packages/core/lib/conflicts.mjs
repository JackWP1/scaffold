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
  // `events` is in timeline order (issueSteps sorts by time, then id): what follows the flag is what came after.
  const at = events.findLastIndex((e) => e.event === 'labeled' && e.label?.name === CONFLICT && e.actor?.login === BOT);
  if (at < 0) return { open: false };
  const flag = events[at];
  const resolution = checkApproval({
    events: events.slice(at + 1),
    label: CONFLICT_RESOLVED,
    approvers,
    comment: { body: '', updated_at: flag.created_at },
    what: 'conflict flag',
  });
  if (resolution.ok) return { open: false, flaggedAt: flag.created_at, resolvedBy: resolution.approver };
  return { open: true, flaggedAt: flag.created_at, reason: resolution.reason };
}
