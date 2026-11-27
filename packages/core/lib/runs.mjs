// Workflow runs on a commit, with the client injected so tests can fake it.

// The latest run of `workflow` (a file name) on `sha`: waits up to `waitMs` for it to complete.
// Returns { run } (completed), { pending: run } (still running at the deadline), { missing: true } or
// { notFound: true } (no such workflow). `sleep` is injected so tests don't wait.
export async function waitForRun(gh, repo, workflow, sha, { waitMs = 15 * 60_000, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const path = `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&per_page=10`;
  for (let waited = 0; ; waited += pollMs) {
    let runs;
    try {
      ({ workflow_runs: runs = [] } = await gh.get(path));
    } catch (err) {
      if (String(err.message).includes(': 404 ')) return { notFound: true };
      throw err;
    }
    const run = runs.filter((r) => r.head_sha === sha).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (run?.status === 'completed') return { run };
    if (waited >= waitMs) return run ? { pending: run } : { missing: true };
    await sleep(pollMs);
  }
}
