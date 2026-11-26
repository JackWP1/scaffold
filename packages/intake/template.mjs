// Detects issues created from the SCAFFOLD Request form (packages/intake/templates/request.yml).
// Issue forms render each field as a `### <label>` heading, so the body has all of them.
// Labels are never renamed (PLAN.md section 5), so this matches old and new forms.
const HEADINGS = ['Jira key', 'Kind', 'What and why', 'Done when'];

export function usesTemplate(body) {
  return HEADINGS.every((h) => new RegExp(`^### ${h}\\s*$`, 'm').test(body ?? ''));
}
