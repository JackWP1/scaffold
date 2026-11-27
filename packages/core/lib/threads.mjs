// Review threads on a PR (GraphQL only: REST has no resolved state). Used by the review gate to count
// unresolved `code-review` threads, and by code-review itself, with the client injected so tests can fake it.

// The marker that starts every code-review comment body (handover contract, PLAN.md section 5).
export const CODE_REVIEW_MARKER = '<!-- scaffold:code-review -->';

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved isOutdated path line comments(first: 1) { nodes { author { login } body url } } }
      }
    }
  }
}`;

// Every thread: { resolved, outdated, path, line, author, body, url } from its first comment.
export async function reviewThreads(gh, repo, number) {
  const [owner, name] = repo.split('/');
  const threads = [];
  for (let after = null; ;) {
    const data = await gh.graphql(QUERY, { owner, name, number, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const t of page.nodes) {
      const first = t.comments.nodes[0] ?? {};
      threads.push({ resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line, author: first.author?.login, body: first.body ?? '', url: first.url });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

// SCAFFOLD's code-review threads still open. A thread whose code has changed since (outdated) still
// counts: someone resolves it after checking the change addressed it.
export async function openCodeReviewThreads(gh, repo, number) {
  return (await reviewThreads(gh, repo, number)).filter((t) => !t.resolved && ['github-actions', 'github-actions[bot]'].includes(t.author) && t.body.startsWith(CODE_REVIEW_MARKER));
}
