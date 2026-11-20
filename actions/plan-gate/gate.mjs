// Entry point for the plan gate composite action (logic in actions/plan/gate.mjs).
import { readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { github } from '../lib/github.mjs';
import { loadConfig } from '../lib/config.mjs';
import { runGate } from '../plan/gate.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const gh = github(process.env.GITHUB_TOKEN);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const schema = JSON.parse(await readFile(join(process.env.SCAFFOLD_ROOT, 'schemas/plan.schema.json'), 'utf8'));

const { skip, lines } = await runGate(gh, repo, { event, schema, config: await loadConfig(gh, repo) });
if (skip) console.log(`Skipping: ${skip}`);
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${skip ? `### SCAFFOLD plan gate\nSkipped: ${skip}` : lines.join('\n')}\n`);
