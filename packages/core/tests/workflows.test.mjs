import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASED } from '../lib/config.mjs';

const ROOT = new URL('../../../', import.meta.url);
const read = (p) => readFile(new URL(p, ROOT), 'utf8');

// Composite action dirs of a package: packages/<pkg>/actions/<name>/action.yml.
async function actionsOf(pkg) {
  return (await readdir(new URL(`packages/${pkg}/actions/`, ROOT))).map((a) => `packages/${pkg}/actions/${a}/action.yml`);
}

test('every package action reads stages first and runs nothing else when its stage is off', async () => {
  for (const pkg of RELEASED) {
    for (const file of await actionsOf(pkg)) {
      const yaml = await read(file);
      const steps = yaml.split(/\n {4}- /).slice(1);
      assert.match(steps[0], new RegExp(`core/bin/stage\\.mjs" ${pkg}(\\n|$)`), `${file}: first step`);
      for (const step of steps.slice(1)) assert.match(step, /steps\.stage\.outputs\.state (?:!= 'off'|== 'on')/, `${file}: ${step.split('\n')[0]}`);
    }
  }
});

test('reusable workflows call package actions, and jobs reading config can read contents', async () => {
  for (const wf of ['triage', 'plan', 'labels', 'config-guard', 'usage-report', 'checks', 'implement']) {
    const yaml = await read(`.github/workflows/${wf}.yml`);
    for (const [, path] of yaml.matchAll(/uses: JackWP1\/scaffold\/(\S+)@/g)) assert.match(path, /^packages\/(core|intake|plan|implement)\/actions\//, wf);
  }
  for (const wf of ['triage', 'plan', 'implement']) {
    const yaml = await read(`.github/workflows/${wf}.yml`);
    for (const job of yaml.split(/\n {2}(?=[a-z-]+:\n)/).slice(1)) assert.match(job, /contents: read/, `${wf}: ${job.split(':')[0]}`);
  }
});

test('workflows: admission is repo-wide, planning per issue, and bot comment edits reach the gate', async () => {
  const wf = await read('.github/workflows/plan.yml');
  assert.match(wf, /group: scaffold-admit-\$\{\{ github\.repository \}\}\n/);
  assert.match(wf, /group: scaffold-plan-\$\{\{ github\.repository \}\}-\$\{\{ matrix\.issue \}\}/);
  for (const file of ['plan', 'triage']) {
    const yaml = file === 'plan' ? wf : await read('.github/workflows/triage.yml');
    assert.match(yaml, /\["edited","deleted"\]'\), github\.event\.action\) && \(github\.event\.comment\.user\.login == 'github-actions\[bot\]' \|\| startsWith\(github\.event\.comment\.body, '<!-- scaffold:scenarios -->'\) \|\| startsWith\(github\.event\.changes\.body\.from, '<!-- scaffold:scenarios -->'\)\)/, file);
  }
});

test('the caller listens for every event a package needs, and grants what each reusable workflow asks', async () => {
  const caller = await read('templates/caller/.github/workflows/scaffold.yml');
  assert.match(caller, /issues:\n\s+types: \[opened, edited, reopened, labeled, unlabeled\]/);
  assert.match(caller, /issue_comment:\n\s+types: \[created, edited, deleted\]/);
  assert.match(caller, /pull_request:\n\s+types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]/);
  assert.match(caller, /pull_request_review:\n\s+types: \[submitted, dismissed\]/);
  assert.match(caller, /schedule:\n\s+- cron:/);
  assert.doesNotMatch(caller, /pull_request_target/);
  const perms = (yaml, job) => [...(yaml.split(new RegExp(`\\n {2}${job}:\\n`))[1].split(/\n {2}[a-z-]+:\n/)[0].matchAll(/^ {6}([a-z-]+): (read|write)$/gm))].map(([, k, v]) => `${k}: ${v}`).sort();
  for (const [job, wf] of [['triage', 'triage'], ['plan', 'plan'], ['config-guard', 'config-guard'], ['checks', 'checks'], ['implement', 'implement'], ['usage-report', 'usage-report'], ['labels', 'labels']]) {
    const reusable = await read(`.github/workflows/${wf}.yml`);
    const asked = new Set([...reusable.matchAll(/^ {6}([a-z-]+): (read|write)$/gm)].map(([, k, v]) => `${k}: ${v}`));
    const granted = perms(caller, job);
    for (const p of asked) assert.ok(granted.includes(p) || granted.includes(p.replace('read', 'write')), `${job} needs ${p}`);
  }
});

test('the self-test workflow runs the diagrams check on PRs, including label changes', async () => {
  const yaml = await read('.github/workflows/self-test.yml');
  assert.match(yaml, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
  assert.match(yaml, /node packages\/core\/diagrams\/check\.mjs/);
});

test('entry points parse', async () => {
  const entries = ['packages/core/bin/stage.mjs'];
  for (const pkg of ['core', ...RELEASED]) {
    for (const a of await readdir(new URL(`packages/${pkg}/actions/`, ROOT))) {
      for (const f of await readdir(new URL(`packages/${pkg}/actions/${a}/`, ROOT))) if (f.endsWith('.mjs')) entries.push(`packages/${pkg}/actions/${a}/${f}`);
    }
  }
  assert.ok(entries.length >= 8);
  for (const f of entries) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(f, ROOT))]);
});

test('each released package has a HANDOFF.md with entry, exit and manual steps', async () => {
  for (const pkg of RELEASED) {
    const md = await read(`packages/${pkg}/HANDOFF.md`);
    for (const h of ['## Entry', '## Checks upstream', '## Exit', `## When ${pkg} is off`]) assert.ok(md.includes(h), `${pkg}: ${h}`);
  }
});
