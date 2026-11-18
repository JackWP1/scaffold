// Entry point for the triage composite action (PLAN.md section 2, slice 1).
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { github } from '../lib/github.mjs';
import { callModel, RateLimited } from '../lib/models.mjs';
import { validate } from '../lib/validate.mjs';
import { wrapUntrusted, skillBody } from '../lib/text.mjs';
import { renderTriage, renderNotice } from './render.mjs';
import { issueSteps } from './steps.mjs';
import { usesTemplate } from './template.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const STATE_LABELS = ['scaffold:triage', 'scaffold:needs-info', 'scaffold:ready', 'scaffold:proposed'];

const root = process.env.SCAFFOLD_ROOT;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const gh = github(token);
const summary = (md) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${md}\n`);

const issue = event.issue;
const labels = issue.labels.map((l) => l.name);

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return summary(`### SCAFFOLD triage\nSkipped: ${reason}`);
}

const { setLabels, upsertStatus, acceptedByMember } = issueSteps(gh, repo, issue.number, labels);

async function main() {
  if (issue.pull_request) return skip('pull request');
  if (event.action === 'edited') return skip('edits do not re-run triage; add scaffold:triage instead');
  if (event.action === 'labeled' && !['scaffold:accepted', 'scaffold:triage'].includes(event.label?.name)) return skip('label is not scaffold:accepted or scaffold:triage');

  const trusted = TRUSTED.includes(issue.author_association)
    || (labels.includes('scaffold:accepted') && await acceptedByMember(event.action === 'labeled' ? event.sender : undefined));
  if (!trusted) {
    const notice = labels.includes('scaffold:accepted')
      ? '🔒 Opened by someone outside the team, and `scaffold:accepted` was not applied by a member with write access. A member must re-apply it before SCAFFOLD triages this issue.'
      : '🔒 Opened by someone outside the team. A member must apply `scaffold:accepted` before SCAFFOLD triages it.';
    await setLabels(['scaffold:proposed'], STATE_LABELS);
    await upsertStatus(renderNotice(notice));
    return summary(`### SCAFFOLD triage\nNot trusted (${issue.author_association}): labelled scaffold:proposed`);
  }

  await setLabels(['scaffold:triage'], STATE_LABELS);

  const skillMd = await readFile(join(root, 'skills/triage/SKILL.md'), 'utf8');
  const schema = JSON.parse(await readFile(join(root, 'schemas/triage.schema.json'), 'utf8'));
  const manifest = await readFile(join(root, 'skills/manifest.yml'), 'utf8');
  const models = await readFile(join(root, 'config/models.yml'), 'utf8');
  const tier = skillMd.match(/^tier:\s*(\S+)/m)[1];
  const model = process.env.SCAFFOLD_MODEL || models.match(new RegExp(`^${tier}:\\s*(\\S+)`, 'm'))[1];
  const skillVersion = manifest.match(/triage:\s*\n\s*version:\s*(\S+)/)[1];

  const user = `Triage this issue.\n\n${wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`)}`;
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  let out;
  try {
    out = await callModel({ token, model, system: skillBody(skillMd), user, schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
    console.warn(err.message);
    await setLabels([], ['scaffold:triage']);
    await upsertStatus(renderNotice(`⚠️ Triage skipped: ${why}. Add the `scaffold:triage` label or re-run the workflow to try again.`));
    return summary(`### SCAFFOLD triage\nSkipped: ${why}\n\n\`${err.message.slice(0, 500)}\``);
  }

  const errors = validate(schema, out);
  if (errors.length) {
    console.log(`::warning::Invalid triage output: ${errors.join('; ')}`);
    await setLabels([], ['scaffold:triage']);
    await upsertStatus(renderNotice('⚠️ Triage produced invalid output, so nothing was applied. Re-run the workflow to try again.'));
    return summary(`### SCAFFOLD triage\nInvalid output (no writes):\n\n- ${errors.join('\n- ')}`);
  }
  if (out.decision === 'ready') out.questions = [];

  const add = [`scaffold:${out.decision}`];
  if (!labels.some((l) => l.startsWith('priority:'))) add.push(`priority:${out.priority}`);
  if (!usesTemplate(issue.body)) add.push('scaffold:no-template');
  await setLabels(add, [...STATE_LABELS, 'scaffold:no-template']);
  await upsertStatus(renderTriage(out, { skillVersion, model }));

  await summary([
    '### SCAFFOLD triage',
    '| Skill | Version | Model | Input hash | Decision |',
    '| --- | --- | --- | --- | --- |',
    `| triage | ${skillVersion} | ${model} | \`${inputHash}\` | ${out.decision} |`,
    '',
    '<details><summary>Validated output</summary>',
    '',
    '```json',
    JSON.stringify(out, null, 2),
    '```',
    '</details>',
  ].join('\n'));
}

await main();
