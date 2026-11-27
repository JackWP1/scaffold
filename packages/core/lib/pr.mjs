// Pull request helpers for the PR checks (PLAN.md section 6), with the client injected so tests can fake it.

// Owners the scaffold repo has lived under; a pin to either is a SCAFFOLD pin (PLAN.md section 5).
export const SCAFFOLD_OWNERS = ['JackWP1', 'ukncsc'];

// Every changed file: { filename, previous_filename?, status, additions, deletions, patch? }.
// The API lists at most 3000 files; `truncated` is set when the PR may have more.
export async function prFiles(gh, repo, number) {
  const files = [];
  for await (const page of gh.pages(`/repos/${repo}/pulls/${number}/files`)) files.push(...page);
  return { files, truncated: files.length >= 3000 };
}

// Glob to RegExp: `**` any path (including none), `*` within one segment, `?` one character.
// A pattern without a slash matches the file name in any directory, as in .gitignore.
export function globToRegExp(glob) {
  const anchored = glob.includes('/') ? glob.replace(/^\//, '') : `**/${glob}`;
  let re = '';
  for (let i = 0; i < anchored.length; i++) {
    const c = anchored[i];
    if (c === '*' && anchored[i + 1] === '*') {
      const slash = anchored[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

// Paths a change touches: a rename touches both its old and new path.
export const pathsOf = (file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])];

// Changed files and lines (additions + deletions), not counting exempt files (PLAN.md section 6).
export function prSize(files, exempt) {
  const counted = files.filter((f) => !pathsOf(f).every((p) => matchesAny(p, exempt)));
  return {
    files: counted.length,
    lines: counted.reduce((n, f) => n + f.additions + f.deletions, 0),
    exempt: files.length - counted.length,
  };
}

// Issues a PR closes, from GitHub's closing keywords in its body (e.g. "Fixes #12"), same repo only.
export function linkedIssues(body) {
  const found = new Set();
  for (const [, n] of String(body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)) found.add(Number(n));
  return [...found];
}

// Added and removed lines of a unified diff patch, without the +/- prefix.
export function patchLines(patch) {
  const added = [];
  const removed = [];
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}
