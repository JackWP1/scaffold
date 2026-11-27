// Entry point for the /gherkin action (logic in packages/intake/gherkin.mjs).
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { github } from '../../../core/lib/github.mjs';
import { callModel } from '../../../core/lib/models.mjs';
import { loadSkill } from '../../../core/lib/skills.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { runGherkin } from '../../gherkin.mjs';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(token);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));

const { skip, lines } = await runGherkin(gh, repo, {
  event,
  ...await tryLoadConfig(gh, repo),
  loadSkill: (name) => loadSkill(PACKAGE, name, process.env.SCAFFOLD_MODEL),
  callModel: (args) => callModel({ token, ...args }),
});
if (skip) console.log(`Skipping: ${skip}`);
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${skip ? `### SCAFFOLD /gherkin\nSkipped: ${skip}` : lines.join('\n')}\n`);
