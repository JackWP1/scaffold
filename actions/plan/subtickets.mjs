// Creates an approved plan's sub-tickets as GitHub sub-issues (PLAN.md section 6), once each.
// Safe to retry: a sub-ticket created on an earlier run but never linked shows on the parent's
// timeline as a cross-reference (its body mentions the parent), so it is linked, not duplicated.
import { renderSubTicket, subTicketMarker } from './render.mjs';

const BOT = 'github-actions[bot]';

export async function createSubTickets(gh, repo, parent, plan, labels) {
  const linked = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/${parent.number}/sub_issues`)) linked.push(...page);
  const referenced = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/${parent.number}/timeline`)) {
    for (const e of page) if (e.event === 'cross-referenced' && e.source?.issue) referenced.push(e.source.issue);
  }
  const mine = (issues, id) => issues.find((i) => i.user?.login === BOT && i.body?.startsWith(subTicketMarker(parent.number, id)));
  const link = (issue) => gh.post(`/repos/${repo}/issues/${parent.number}/sub_issues`, { sub_issue_id: issue.id });

  const numbers = {};
  const created = [];
  for (const t of plan.subtasks) {
    const found = mine(linked, t.id) ?? mine(referenced, t.id);
    if (found) {
      if (!linked.includes(found)) await link(found);
      numbers[t.id] = found.number;
      continue;
    }
    const issue = await gh.post(`/repos/${repo}/issues`, {
      title: `${t.title.replace(/\s+/g, ' ').trim()} (#${parent.number} part ${t.id})`,
      body: renderSubTicket(t, { parent: parent.number, numbers }),
      labels: labels.filter((l) => l.startsWith('priority:')),
    });
    await link(issue);
    numbers[t.id] = issue.number;
    created.push(issue.number);
  }
  return { numbers, created };
}
