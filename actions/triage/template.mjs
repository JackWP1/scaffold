// Detects issues created from the SCAFFOLD Request form (templates/caller/.github/ISSUE_TEMPLATE/request.yml).
// Issue forms render each field as a `### <label>` heading, so the body has all of them.
const HEADINGS = ['Jira key', 'Kind', 'What and why', 'Done when'];

export function usesTemplate(body) {
  return HEADINGS.every((h) => new RegExp(`^### ${h}\\s*$`, 'm').test(body ?? ''));
}
