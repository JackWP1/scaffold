// gherkin-writer (PLAN.md section 2, Scenarios): drafts scenarios with one tool-less model call, and
// one retry if the Gherkin doesn't parse. Actions code numbers them and builds the scenarios comment.
import { createHash } from 'node:crypto';
import { wrapUntrusted } from '../core/lib/text.mjs';
import { validate } from '../core/lib/validate.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { renderScenarios, parseProblem } from './scenarios.mjs';

// Returns { body, count, notes, skillVersion, model, inputHash } or { error, detail }.
// `triage` is the triage brief or status text; `previous` the current scenarios' Gherkin; `guidance`
// the text after `/gherkin`. All are untrusted.
export async function draftScenarios({ issue, triage, previous, guidance, approvers, loadSkill, callModel }) {
  const { system, schema, version: skillVersion, model } = await loadSkill('gherkin-writer');
  const user = [
    'Write acceptance scenarios for this issue.',
    wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`),
    triage ? wrapUntrusted('untrusted_triage', triage) : '',
    previous ? wrapUntrusted('untrusted_previous_scenarios', previous) : '',
    guidance ? wrapUntrusted('untrusted_guidance', guidance) : '',
  ].filter(Boolean).join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  let errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYour previous Gherkin didn't parse; fix these:\n${errors.map((e) => `- ${e}`).join('\n')}`;
    let out;
    try {
      out = await callModel({ model, system, user: prompt, schema });
    } catch (err) {
      console.warn(err.message);
      return { error: err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed', detail: err.message.slice(0, 500) };
    }
    const invalid = validate(schema, out);
    if (invalid.length) return { error: 'invalid output, nothing posted', detail: invalid.join('; ') };
    const source = `drafted by gherkin-writer v${skillVersion} · ${model} · AI-generated: check before approving`;
    const r = renderScenarios(out.gherkin, { issue: issue.number, source, approvers, notes: out.notes });
    if (!r.errors) return { ...r, notes: out.notes, skillVersion, model, inputHash };
    errors = r.errors;
  }
  return { error: `the draft didn't parse: ${parseProblem(errors)}`, detail: errors.join('; ') };
}

// One audit row for the job summary.
export const draftAudit = (d) => [
  '| Skill | Version | Model | Input hash | Outcome |',
  '| --- | --- | --- | --- | --- |',
  d.error ? `| gherkin-writer | - | - | - | failed: ${d.error} |` : `| gherkin-writer | ${d.skillVersion} | ${d.model} | \`${d.inputHash}\` | ${d.count} scenarios drafted |`,
];
