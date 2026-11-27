// Entry point for the review package's PR jobs (logic in packages/review/). SCAFFOLD_MODE: code-review or
// ci-diagnose. Never fails the job on a model problem: the summary says what happened.
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { github } from '../../../core/lib/github.mjs';
import { callModel } from '../../../core/lib/models.mjs';
import { loadSkill } from '../../../core/lib/skills.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { escapeForComment } from '../../../core/lib/text.mjs';
import { runCodeReview } from '../../reviewer.mjs';
import { runCiDiagnose } from '../../diagnoser.mjs';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const mode = process.env.SCAFFOLD_MODE;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(token);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const run = { 'code-review': runCodeReview, 'ci-diagnose': runCiDiagnose }[mode];
if (!run) throw new Error(`unknown mode ${mode}`);

// Config from the PR's base commit, so a PR can't change what reviews it.
const { config, configError } = await tryLoadConfig(gh, repo, event.pull_request?.base?.sha);
const result = configError
  ? { lines: [`### SCAFFOLD ${mode}`, `Skipped: \`.github/scaffold-config.yml\` on the base branch is invalid: ${escapeForComment(configError)}`] }
  : await run(gh, repo, {
    event,
    config,
    loadSkill: (name) => loadSkill(PACKAGE, name, process.env.SCAFFOLD_MODEL),
    callModel: (args) => callModel({ token, ...args }),
  });
if (result.skip) console.log(`Skipping: ${result.skip}`);
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${result.skip ? `### SCAFFOLD ${mode}\nSkipped: ${result.skip}` : result.lines.join('\n')}\n`);
