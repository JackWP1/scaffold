import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseWorkflow, diagramProblems, currentDiagram, callerTriggers, workflowJobs, replaceGenerated, consistencyProblems, planWithoutDiagram, START, END,
} from '../diagrams/diagrams.mjs';

const ROOT = new URL('../../../', import.meta.url);
const read = (p) => readFile(new URL(p, ROOT), 'utf8');

test('scaffold-diagrams passes on this repo: diagrams fresh, workflow.yml matches the code', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('packages/core/diagrams/check.mjs', ROOT))], { encoding: 'utf8', env: { ...process.env, BASE_SHA: '' } });
  assert.match(out, /scaffold-diagrams: ok/);
});

test('workflow.yml diagram problems are reported', () => {
  const diagram = { nodes: { a: { text: 'A' }, b: { kind: 'robot', text: 'B' }, c: { text: 'say "hi"' }, d: { owner: 'nobody', text: 'D' } }, edges: ['a --> b', 'a -> c', 'b -- x --> z'] };
  const problems = diagramProblems(diagram);
  assert.ok(problems.includes('node b: unknown kind robot'));
  assert.ok(problems.includes('node c: text must be set and have no double quotes'));
  assert.ok(problems.includes('node d: unknown owner nobody'));
  assert.ok(problems.includes('edge "a -> c": not "a --> b" or "a -- label --> b"'));
  assert.ok(problems.includes('edge "b -- x --> z": unknown node z'));
  assert.ok(problems.includes('node d: not on any edge'));
});

test('the Current diagram colours nodes by owner and keeps edge labels', () => {
  const out = currentDiagram({ nodes: { a: { kind: 'human', owner: 'manual', text: 'A' }, b: { kind: 'ai', text: 'B' } }, edges: ['a -- go --> b'] });
  assert.match(out, /^ {2}a\{".*<br\/>A"\}$/m);
  assert.match(out, /^ {2}b\[".*🤖.* B"\]$/m);
  assert.match(out, /^ {2}a -- go --> b$/m);
  assert.match(out, /^ {2}class b scaffold$/m);
  assert.match(out, /^ {2}class a manual$/m);
});

test('caller triggers and jobs are read from the caller template', async () => {
  const caller = await read('templates/caller/.github/workflows/scaffold.yml');
  const triggers = callerTriggers(caller);
  assert.ok(triggers.includes('issues.labeled') && triggers.includes('pull_request_review.dismissed') && triggers.includes('schedule') && triggers.includes('workflow_dispatch'));
  assert.deepEqual(Object.keys(workflowJobs(caller)), ['triage', 'plan', 'config-guard', 'checks', 'usage-report', 'labels']);
  assert.deepEqual(workflowJobs(await read('.github/workflows/plan.yml')).plan.needs, ['admit']);
});

test('workflow.yml drift from labels, triggers, workflows or skills is caught', async () => {
  const workflow = parseWorkflow(await read('packages/core/config/workflow.yml'));
  const callerYaml = await read('templates/caller/.github/workflows/scaffold.yml');
  const workflowFiles = { 'triage.yml': await read('.github/workflows/triage.yml'), 'plan.yml': await read('.github/workflows/plan.yml'), 'labels.yml': '', 'config-guard.yml': '', 'usage-report.yml': '', 'checks.yml': '', 'extra.yml': '' };
  const labels = [...workflow.reserved_labels, ...Object.values(workflow.stages).flatMap((s) => s.labels)];
  const skills = { intake: ['triage', 'gherkin-writer'], plan: ['task-decomposer', 'gherkin-writer'] };
  const problems = consistencyProblems({ workflow, labels: [...labels.filter((l) => l !== 'scaffold:too-big'), 'scaffold:new'], callerYaml: callerYaml.replace(', dismissed', ''), workflowFiles, skills });
  assert.deepEqual(problems.sort(), [
    'label scaffold:new is in labels.yml but not in workflow.yml',
    'label scaffold:too-big is in workflow.yml but not in labels.yml',
    'skill gherkin-writer in packages/plan/skills/ is not in workflow.yml',
    'trigger pull_request_review.dismissed is in workflow.yml but not in the caller template',
    'workflow extra.yml is not in workflow.yml',
  ]);
});

test('generated blocks are replaced between the markers only', () => {
  const md = `intro\n${START}\nold\n${END}\noutro`;
  assert.equal(replaceGenerated(md, 'new'), `intro\n${START}\nnew\n${END}\noutro`);
  assert.throws(() => replaceGenerated('no markers', 'x'), /no generated block/);
});

test('a PLAN.md workflow change needs a diagram change or scaffold:diagram-unchanged', () => {
  const plan = (s6) => `# P\n\n## 2. What\n\nx\n\n## 5. Layout\n\ny\n\n## 6. Guardrails\n\n${s6}\n\n## 8. Humans\n\nz\n`;
  const base = plan('gates');
  assert.equal(planWithoutDiagram({ basePlan: base, headPlan: base.replace('y', 'y2'), changedFiles: ['PLAN.md'], labels: [] }), null, 'section 5 is not workflow');
  assert.match(planWithoutDiagram({ basePlan: base, headPlan: plan('new gates'), changedFiles: ['PLAN.md'], labels: [] }), /section 6 changed without a change in docs\/diagrams\//);
  assert.equal(planWithoutDiagram({ basePlan: base, headPlan: plan('new gates'), changedFiles: ['PLAN.md', 'docs/diagrams/workflow.md'], labels: [] }), null);
  assert.equal(planWithoutDiagram({ basePlan: base, headPlan: plan('new gates'), changedFiles: ['PLAN.md'], labels: ['scaffold:diagram-unchanged'] }), null);
});
