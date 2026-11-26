// scaffold-diagrams check for this repo (PLAN.md section 10), run by self-test.
//   node packages/core/diagrams/check.mjs          fail if diagrams are stale or workflow.yml disagrees
//   node packages/core/diagrams/check.mjs --write  regenerate the diagrams
// On a PR, set BASE_SHA and PR_LABELS (JSON list) to also check PLAN.md workflow changes.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseLabels } from '../lib/labels.mjs';
import {
  parseWorkflow, currentDiagram, actionsDiagram, replaceGenerated, consistencyProblems, planWithoutDiagram,
} from './diagrams.mjs';

const ROOT = new URL('../../../', import.meta.url);
const read = (p) => readFile(new URL(p, ROOT), 'utf8');
const write = process.argv.includes('--write');

const workflow = parseWorkflow(await read('packages/core/config/workflow.yml'));
const labels = parseLabels(await read('packages/core/config/labels.yml')).map((l) => l.name);
const callerYaml = await read('templates/caller/.github/workflows/scaffold.yml');
const workflowFiles = {};
for (const f of (await readdir(new URL('.github/workflows/', ROOT))).sort()) workflowFiles[f] = await read(`.github/workflows/${f}`);
const skills = {};
for (const pkg of Object.keys(workflow.stages ?? {})) {
  skills[pkg] = (await readdir(new URL(`packages/${pkg}/skills/`, ROOT), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
}

const problems = consistencyProblems({ workflow, labels, callerYaml, workflowFiles, skills });

const { 'self-test.yml': _, ...reusable } = workflowFiles;
const targets = {
  'docs/diagrams/workflow.md': currentDiagram(workflow.diagram),
  'docs/diagrams/architecture.md': actionsDiagram(callerYaml, reusable),
};
for (const [file, generated] of Object.entries(targets)) {
  const committed = await read(file);
  const fresh = replaceGenerated(committed, generated);
  if (fresh === committed) continue;
  if (write) {
    await writeFile(new URL(file, ROOT), fresh);
    console.log(`wrote ${file}`);
  } else {
    problems.push(`${file} is stale: run node packages/core/diagrams/check.mjs --write`);
  }
}

if (process.env.BASE_SHA) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const problem = planWithoutDiagram({
    basePlan: git('show', `${process.env.BASE_SHA}:PLAN.md`),
    headPlan: await read('PLAN.md'),
    changedFiles: git('diff', '--name-only', `${process.env.BASE_SHA}...HEAD`).split('\n').filter(Boolean),
    labels: JSON.parse(process.env.PR_LABELS || '[]') ?? [],
  });
  if (problem) problems.push(problem);
}

if (problems.length) {
  for (const p of problems) console.log(`::error::scaffold-diagrams: ${p}`);
  process.exitCode = 1;
} else {
  console.log('scaffold-diagrams: ok');
}
