// Entry point for the triage composite action (PLAN.md section 2, slice 1).
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { github } from '../lib/github.mjs';
import { callModel, RateLimited } from '../lib/models.mjs';
import { validate } from '../lib/validate.mjs';
import { wrapUntrusted, skillBody } from '../lib/text.mjs';
import { MARKER, renderTriage, renderNotice } from './render.mjs';

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
const base = `/repos/${repo}/issues/${issue.number}`;

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  return summary(`### SCAFFOLD triage\nSkipped: ${reason}`);
}

async function setLabels(add, remove) {
  for (const name of remove.filter((l) => labels.includes(l) && !add.includes(l))) {
    await gh.delete(`${base}/labels/${encodeURIComponent(name)}`);
  }
  if (add.length) await gh.post(`${base}/labels`, { labels: add });
}

async function upsertStatus(body) {
  const comments = await gh.get(`${base}/comments?per_page=100`);
  const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
  if (mine) await gh.patch(`/repos/${repo}/issues/comments/${mine.id}`, { body });
  else await gh.post(`${base}/comments`, { body });
}

async function main() {
  if (issue.pull_request) return skip('pull request');
  if (event.action === 'labeled' && event.label?.name !== 'scaffold:accepted') return skip('label is not scaffold:accepted');
  if (event.action === 'edited' && !labels.includes('scaffold:needs-info')) return skip('edited but not waiting for info');

  const trusted = TRUSTED.includes(issue.author_association) || labels.includes('scaffold:accepted');
  if (!trusted) {
    await setLabels(['scaffold:proposed'], STATE_LABELS);
    await upsertStatus(renderNotice('🔒 Opened by someone outside the team. A member must apply `scaffold:accepted` before SCAFFOLD triages it.'));
    return summary(`### SCAFFOLD triage\nNot trusted (${issue.author_association}): labelled scaffold:proposed`);
  }

  await setLabels(['scaffold:triage'], STATE_LABELS);

  const skillMd = await readFile(join(root, 'skills/triage/SKILL.md'), 'utf8');
  const schema = JSON.parse(await readFile(join(root, 'schemas/triage.schema.json'), 'utf8'));
  const manifest = await readFile(join(root, 'skills/manifest.yml'), 'utf8');
  const models = await readFile(join(root, 'config/models.yml'), 'utf8');
  const tier = skillMd.match(/^tier:\s*(\S+)/m)[1];
  const endpoint = process.env.SCAFFOLD_MODELS_ENDPOINT || undefined;
  const model = process.env.SCAFFOLD_MODEL || models.match(new RegExp(`^${tier}:\\s*(\\S+)`, 'm'))[1];
  const skillVersion = manifest.match(/triage:\s*\n\s*version:\s*(\S+)/)[1];

  const user = `Triage this issue.\n\n${wrapUntrusted('untrusted_issue', `Title: ${issue.title}\n\n${issue.body ?? ''}`)}`;
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  let out;
  try {
    out = await callModel({ token, model, endpoint, system: skillBody(skillMd), user, schemaName: 'triage', schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'GitHub Models is rate limiting' : 'the model call failed';
    console.log(`::warning::${err.message}`);
    await setLabels([], ['scaffold:triage']);
    await upsertStatus(renderNotice(`⚠️ Triage skipped: ${why}. Edit the issue or re-run the workflow to try again.`));
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
  await setLabels(add, STATE_LABELS);
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
