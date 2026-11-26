// Timeline approval check shared by every gate (PLAN.md sections 5 and 6). Labels alone are not
// protection: the latest event applying `label` must come from a listed approver who is a person,
// not the issue author, and after the approved comment's last change.
import { createHash } from 'node:crypto';

export const commentHash = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);

// `what` names the approved thing in reasons, e.g. 'plan'; `missing` is the reason when there is no comment.
// Returns { ok, reason?, approver, at, eventId, hash? }; approver, at and eventId are set once the event is found.
export function checkApproval({ events, label, author, approvers, comment, what, missing = `there is no ${what}` }) {
  const applied = events.filter((e) => e.event === 'labeled' && e.label?.name === label).at(-1);
  if (!applied) return { ok: false, reason: `\`${label}\` was not applied` };
  const actor = applied.actor ?? {};
  const found = { approver: actor.login, at: applied.created_at, eventId: applied.id };
  const fail = (reason) => ({ ok: false, reason, ...found });
  if (actor.type !== 'User') return fail('applied by a bot, not a person');
  if (actor.login?.toLowerCase() === author?.toLowerCase()) return fail('the issue author can\'t approve their own issue');
  if (!approvers.includes(actor.login?.toLowerCase())) return fail(`\`${actor.login}\` is not a listed approver in \`.github/scaffold-config.yml\``);
  if (!comment) return fail(missing);
  if (Date.parse(comment.updated_at) > Date.parse(applied.created_at)) return fail(`the ${what} changed after it was approved: review it and apply the label again`);
  return { ok: true, ...found, hash: commentHash(comment.body) };
}
