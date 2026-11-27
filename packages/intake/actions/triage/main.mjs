// Entry point for the triage action (logic in packages/intake/triage.mjs).
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { github } from '../../../core/lib/github.mjs';
import { callModel } from '../../../core/lib/models.mjs';
import { loadSkill } from '../../../core/lib/skills.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { runTriage } from '../../triage.mjs';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(token);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));

const summary = await runTriage(gh, repo, {
  event,
  ...await tryLoadConfig(gh, repo),
  // The model input overrides the fast tier, so only triage's model.
  loadSkill: (name) => loadSkill(PACKAGE, name, name === 'triage' ? process.env.SCAFFOLD_MODEL : undefined),
  callModel: (args) => callModel({ token, ...args }),
});
if (summary.includes('\nSkipped: ')) console.log(summary.split('\n')[1]);
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${summary}\n`);
