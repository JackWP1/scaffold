// Entry point for the scenarios gate action (logic in packages/intake/gate.mjs).
import { readFile, appendFile } from 'node:fs/promises';
import { github } from '../../../core/lib/github.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { runScenariosGate } from '../../gate.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const gh = github(process.env.GITHUB_TOKEN);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));

const { skip, lines } = await runScenariosGate(gh, repo, { event, ...await tryLoadConfig(gh, repo) });
if (skip) console.log(`Skipping: ${skip}`);
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${skip ? `### SCAFFOLD scenarios gate\nSkipped: ${skip}` : lines.join('\n')}\n`);
