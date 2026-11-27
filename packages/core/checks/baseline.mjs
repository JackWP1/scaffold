// Baseline PR checks that need only the PR's files (PLAN.md section 6): protected paths and the hard
// size limit. Core, always on, whatever `stages` says. Pure: each returns { ok, outcome, details }.
import { matchesAny, pathsOf, prSize, patchLines, SCAFFOLD_OWNERS } from '../lib/pr.mjs';
import { CONFIG_PATH } from '../lib/config.mjs';

export const PROTECTED = ['.github/**', 'CODEOWNERS', 'PRECEDENTS.md', 'docs/spec/**'];
export const CALLER_PATH = '.github/workflows/scaffold.yml';

const PIN = new RegExp(`^(\\s*(?:-\\s+)?uses:\\s*(?:${SCAFFOLD_OWNERS.join('|')})/scaffold/\\S+)@(\\S+)(?:\\s+#.*)?$`);
const SHA = /^[0-9a-f]{40}$/;

// A change to the caller that only moves SCAFFOLD pins: every changed line is a SCAFFOLD `uses:` line,
// the removed and added lines are the same once refs are taken out (a Dependabot bump), and every new
// ref is a full commit SHA, so a PR can't swap a pin for a branch or tag (PLAN.md section 5).
export function pinOnly(file) {
  if (file.status !== 'modified' || file.patch === undefined) return false;
  const { added, removed } = patchLines(file.patch);
  if (!added.length || added.length !== removed.length) return false;
  if (!added.every((l) => SHA.test(l.match(PIN)?.[2] ?? ''))) return false;
  const norm = (lines) => lines.map((l) => l.match(PIN)?.[1]).sort();
  const a = norm(added);
  const r = norm(removed);
  return a.every(Boolean) && r.every(Boolean) && a.every((l, i) => l === r[i]);
}

// `.github/scaffold-config.yml` has its own check (scaffold-config-guard); a caller pin bump passes.
export function protectedPaths(files) {
  const hits = [];
  for (const f of files) {
    const paths = pathsOf(f).filter((p) => matchesAny(p, PROTECTED) && p !== CONFIG_PATH);
    if (!paths.length) continue;
    if (paths.every((p) => p === CALLER_PATH) && pinOnly(f)) continue;
    hits.push(...paths);
  }
  const unique = [...new Set(hits)].sort();
  if (!unique.length) return { ok: true, outcome: 'no protected paths changed', details: [] };
  return {
    ok: false,
    outcome: `changes protected paths: ${unique.length} file${unique.length === 1 ? '' : 's'}`,
    details: [
      'Protected (PLAN.md section 6): `.github/**`, `CODEOWNERS`, `PRECEDENTS.md`, `docs/spec/**`. A human changes these in a separate PR.',
      '',
      ...unique.slice(0, 50).map((p) => `- \`${p.replace(/`/g, '')}\``),
      ...(unique.length > 50 ? [`- … and ${unique.length - 50} more`] : []),
      ...(unique.includes(CALLER_PATH) ? ['', `\`${CALLER_PATH}\` may only change its SCAFFOLD pins.`] : []),
    ],
  };
}

const fmt = (s) => `${s.files} files / ${s.lines} lines`;

// The hard limit can't be lifted, even by a size exception: the PR must be split.
export function hardSize(files, prSizeConfig, { truncated = false } = {}) {
  const size = prSize(files, prSizeConfig.exempt);
  const { hard } = prSizeConfig;
  const note = size.exempt ? ` (${size.exempt} exempt file${size.exempt === 1 ? '' : 's'} not counted)` : '';
  if (truncated) return { ok: false, outcome: 'more than 3000 files changed: over the hard limit', details: [], size };
  if (size.files > hard.files || size.lines > hard.lines) {
    return {
      ok: false,
      outcome: `${fmt(size)} is over the hard limit (${fmt(hard)})${note}`,
      details: ['The hard limit can\'t be lifted, even with `scaffold:size-exception`: split the work into a stack of PRs or smaller tickets.'],
      size,
    };
  }
  return { ok: true, outcome: `${fmt(size)}, within the hard limit (${fmt(hard)})${note}`, details: [], size };
}
