// Detects issues created from the SCAFFOLD Request form (packages/intake/templates/request.yml).
// Issue forms render each field as a `### <label>` heading, so the body has all of them.
// Labels are never renamed (PLAN.md section 5), so this matches old and new forms.
const HEADINGS = ['Jira key', 'Kind', 'What and why', 'Done when'];
// Optional and added later, so not a template check heading: older issues don't have it.
const GHERKIN = 'Scenarios (Gherkin)';

export function usesTemplate(body) {
  return HEADINGS.every((h) => new RegExp(`^### ${h}\\s*$`, 'm').test(body ?? ''));
}

// The author's scenarios from the form's Gherkin field, or null if the field is missing or blank.
// The form renders it in a ```gherkin fence; GitHub writes `_No response_` for a blank field.
export function formGherkin(body) {
  const m = (body ?? '').replace(/\r\n?/g, '\n').match(new RegExp(`^### ${GHERKIN.replace(/[()]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'm'));
  if (!m) return null;
  const text = m[1].trim().replace(/^```(?:gherkin)?\n([\s\S]*?)\n```$/, '$1').trim();
  return text && text !== '_No response_' ? text : null;
}
