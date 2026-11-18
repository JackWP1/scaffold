// Creates an approved plan's sub-tickets as GitHub sub-issues (PLAN.md section 6), once each.
import { renderSubTicket, subTicketMarker } from './render.mjs';

export async function createSubTickets(gh, repo, parent, plan, labels) {
  const existing = [];
  for await (const page of gh.pages(`/repos/${repo}/issues/${parent.number}/sub_issues`)) existing.push(...page);
  const numbers = {};
  const created = [];
  for (const t of plan.subtasks) {
    const found = existing.find((i) => i.body?.startsWith(subTicketMarker(parent.number, t.id)));
    if (found) {
      numbers[t.id] = found.number;
      continue;
    }
    const issue = await gh.post(`/repos/${repo}/issues`, {
      title: `${t.title.replace(/\s+/g, ' ').trim()} (#${parent.number} part ${t.id})`,
      body: renderSubTicket(t, { parent: parent.number, numbers }),
      labels: labels.filter((l) => l.startsWith('priority:')),
    });
    await gh.post(`/repos/${repo}/issues/${parent.number}/sub_issues`, { sub_issue_id: issue.id });
    numbers[t.id] = issue.number;
    created.push(issue.number);
  }
  return { numbers, created };
}
