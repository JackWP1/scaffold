// The BDD runner report (PLAN.md section 2, runner report contract): Cucumber JSON in an Actions artifact
// from `bdd.workflow`'s run for the PR's head SHA. Missing, unreadable or stale fails closed.
import { inflateRawSync } from 'node:zlib';

export const MAX_REPORT_BYTES = 20 * 1024 * 1024;

// Files in a zip archive (stored or deflated), as { name: Buffer }. Enough for Actions artifacts.
export function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const files = {};
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = inflateRawSync(data, { maxOutputLength: MAX_REPORT_BYTES });
    else throw new Error(`unsupported zip method ${method}`);
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return files;
}

// Scenario results by tag from a Cucumber JSON report: tag → 'passed' | 'failed'. A scenario passes when
// every step (and hook) passed; an outline's examples share tags, so every one must pass.
export function cucumberResults(json) {
  const results = new Map();
  if (!Array.isArray(json)) throw new Error('not a Cucumber JSON report (expected a list of features)');
  for (const feature of json) {
    for (const el of feature?.elements ?? []) {
      if (el.type && el.type !== 'scenario') continue;
      const steps = [...(el.before ?? []), ...(el.steps ?? []), ...(el.after ?? [])];
      const passed = steps.length > 0 && steps.every((s) => s.result?.status === 'passed');
      for (const t of [...(feature.tags ?? []), ...(el.tags ?? [])]) {
        if (!t?.name) continue;
        results.set(t.name, results.get(t.name) === 'failed' || !passed ? 'failed' : 'passed');
      }
    }
  }
  return results;
}

// The report for `sha`: waits up to `waitMs` for the workflow run to complete, then reads the artifact.
// Returns { results } or { error }. `sleep` is injected so tests don't wait.
export async function bddReport(gh, repo, { bdd, sha, waitMs = 15 * 60_000, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const runsPath = `/repos/${repo}/actions/workflows/${encodeURIComponent(bdd.workflow)}/runs?head_sha=${sha}&per_page=10`;
  let run;
  for (let waited = 0; ; waited += pollMs) {
    let runs;
    try {
      ({ workflow_runs: runs = [] } = await gh.get(runsPath));
    } catch (err) {
      if (String(err.message).includes(': 404 ')) return { error: `workflow \`${bdd.workflow}\` (\`bdd.workflow\`) not found` };
      throw err;
    }
    run = runs.filter((r) => r.head_sha === sha).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (run?.status === 'completed') break;
    if (waited >= waitMs) return { error: run ? `\`${bdd.workflow}\` hasn't finished for ${sha.slice(0, 7)}: re-run this check when it has` : `no \`${bdd.workflow}\` run for ${sha.slice(0, 7)} yet: re-run this check when CI has run` };
    await sleep(pollMs);
  }
  const { artifacts = [] } = await gh.get(`/repos/${repo}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(bdd.artifact)}`);
  const artifact = artifacts.find((a) => a.name === bdd.artifact && !a.expired);
  if (!artifact) return { error: `no \`${bdd.artifact}\` artifact (\`bdd.artifact\`) in \`${bdd.workflow}\` run ${run.id}` };
  if (artifact.size_in_bytes > MAX_REPORT_BYTES) return { error: `the \`${bdd.artifact}\` artifact is over ${MAX_REPORT_BYTES / 1024 / 1024} MB` };
  try {
    const files = unzip(await gh.download(`/repos/${repo}/actions/artifacts/${artifact.id}/zip`));
    const report = Object.entries(files).find(([name]) => name.endsWith('.json'));
    if (!report) return { error: `the \`${bdd.artifact}\` artifact has no .json report` };
    return { results: cucumberResults(JSON.parse(report[1].toString('utf8'))), run };
  } catch (err) {
    return { error: `the \`${bdd.artifact}\` report can't be read: ${err.message}` };
  }
}
