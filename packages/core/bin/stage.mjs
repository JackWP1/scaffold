// First step of every package action (PLAN.md section 5): reads `stages` from scaffold-config.yml.
// Usage: node stage.mjs <stage>. Outputs `state`: on, off or invalid. An invalid file doesn't skip the
// package: its own code reports the error and blocks (fail closed).
import { appendFile } from 'node:fs/promises';
import { github } from '../lib/github.mjs';
import { tryLoadConfig, stageOn } from '../lib/config.mjs';

const stage = process.argv[2];
const { config, configError } = await tryLoadConfig(github(process.env.GITHUB_TOKEN), process.env.GITHUB_REPOSITORY);
const state = configError ? 'invalid' : stageOn(config, stage) ? 'on' : 'off';
console.log(`Stage ${stage}: ${state}`);
await appendFile(process.env.GITHUB_OUTPUT ?? '/dev/null', `state=${state}\n`);
if (state === 'off') {
  await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `### SCAFFOLD ${stage}\nStage off: manual. Humans follow \`packages/${stage}/HANDOFF.md\`.\n`);
}
