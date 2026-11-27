// Entry point for the collaboration package's jobs (logic in packages/collaboration/). SCAFFOLD_MODE:
// check-1, check-2, resolve or merge-order. merge-order fails the job (it's a required check in the merge
// queue); the others never do: their result is the label, comment and status rows.
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { github } from '../../../core/lib/github.mjs';
import { callModel } from '../../../core/lib/models.mjs';
import { loadSkill } from '../../../core/lib/skills.mjs';
import { tryLoadConfig } from '../../../core/lib/config.mjs';
import { escapeForComment } from '../../../core/lib/text.mjs';
import { runCheck1, runCheck2, runResolve } from '../../conflict.mjs';
import { mergeOrderCheck, refreshOrder } from '../../merge.mjs';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const mode = process.env.SCAFFOLD_MODE;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const gh = github(token);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const summary = (lines) => appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${lines.join('\n')}\n`);
const { config, configError } = await tryLoadConfig(gh, repo);

if (mode === 'merge-order') {
  const r = configError
    ? { ok: false, outcome: `\`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}`, details: [] }
    : await mergeOrderCheck(gh, repo, { event, config });
  await summary(['### scaffold-merge-order', `${r.ok ? '✅' : '❌'} ${r.outcome}`, ...(r.details.length ? ['', ...r.details] : [])]);
  if (!r.ok) {
    console.log(`::error::${r.outcome}`);
    process.exitCode = 1;
  }
} else {
  const run = { 'check-1': runCheck1, 'check-2': runCheck2, resolve: runResolve }[mode];
  if (!run) throw new Error(`unknown mode ${mode}`);
  if (configError) {
    await summary([`### SCAFFOLD ${mode}`, `Skipped: \`.github/scaffold-config.yml\` is invalid: ${escapeForComment(configError)}`]);
  } else {
    const deps = { event, config, loadSkill: (name) => loadSkill(PACKAGE, name, process.env.SCAFFOLD_MODEL), callModel: (args) => callModel({ token, ...args }) };
    const result = await run(gh, repo, deps);
    const order = mode === 'check-2' && !result.skip ? await refreshOrder(gh, repo, { config }) : { lines: [] };
    await summary(result.skip ? [`### SCAFFOLD ${mode}`, `Skipped: ${result.skip}`] : [...result.lines, '', ...order.lines]);
  }
}
