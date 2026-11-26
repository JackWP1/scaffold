// Entry point for the plan action's plan mode (logic in packages/plan/planner.mjs).
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { github } from '../../../core/lib/github.mjs';
import { callModel } from '../../../core/lib/models.mjs';
import { loadSkill } from '../../../core/lib/skills.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { runPlan } from '../../planner.mjs';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(token);

const summary = await runPlan(gh, repo, {
  event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
  issueNumber: Number(process.env.SCAFFOLD_ISSUE),
  commentId: Number(process.env.SCAFFOLD_COMMENT),
  ...await tryLoadConfig(gh, repo),
  loadSkill: () => loadSkill(PACKAGE, 'task-decomposer', process.env.SCAFFOLD_MODEL),
  callModel: (args) => callModel({ token, ...args }),
});
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${summary}\n`);
