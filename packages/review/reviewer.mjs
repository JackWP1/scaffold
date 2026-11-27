// code-review (PLAN.md section 2, slice 4): one tool-less model call per PR head commit, posted as a review
// that only comments (`COMMENT`, never `APPROVE`). The review gate (implement package) waits until every
// code-review thread is resolved. Client and model are injected so tests can fake them. Imports only core.
import { createHash } from 'node:crypto';
import { wrapUntrusted, escapeForComment as e } from '../core/lib/text.mjs';
import { validate } from '../core/lib/validate.mjs';
import { RateLimited } from '../core/lib/models.mjs';
import { readRepoFile } from '../core/lib/config.mjs';
import { prFiles, linkedIssues } from '../core/lib/pr.mjs';
import { MARKER } from '../core/lib/status.mjs';
import { issueSteps } from '../core/lib/issue.mjs';
import { approvedScenarios } from '../core/lib/scenarios.mjs';
import { scenariosText } from '../core/lib/gherkin.mjs';
import { CODE_REVIEW_MARKER } from '../core/lib/threads.mjs';

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const COPILOT = ['Copilot', 'copilot-swe-agent[bot]'];
const BOT = 'github-actions[bot]';
// The plan package's marked comment (handover contract, PLAN.md section 5): read, never imported.
const PLAN_MARKER = '<!-- scaffold:plan -->';
const MAX_DIFF_CHARS = 60_000;
const runMarker = (sha) => `<!-- scaffold:code-review-run ${sha} -->`;
const heading = '### SCAFFOLD code-review';

// New-side line numbers a review comment can attach to: added and context lines in each hunk.
export function commentableLines(patch) {
  const lines = new Set();
  let line = 0;
  for (const l of String(patch ?? '').split('\n')) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!line) continue;
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    lines.add(line++);
  }
  return lines;
}

// The diff as the model sees it, capped; `truncated` lists files left out.
export function diffText(files, max = MAX_DIFF_CHARS) {
  const parts = [];
  const left = [];
  let size = 0;
  for (const f of files) {
    const text = f.patch === undefined ? `--- ${f.filename} (${f.status}; diff too large to show)` : `--- ${f.filename} (${f.status})\n${f.patch}`;
    if (size + text.length > max) { left.push(f.filename); continue; }
    parts.push(text);
    size += text.length;
  }
  return { text: parts.join('\n\n'), truncated: left };
}

const commentBody = (c) => `${CODE_REVIEW_MARKER}\n**${c.axis} · ${c.severity}**\n\n${e(c.body)}`;

// Returns { skip } or { lines } for the job summary. Never fails the job: a model problem is reported
// in the summary and the review gate passes without code-review threads to wait for.
export async function runCodeReview(gh, repo, { event, config, loadSkill, callModel }) {
  const pr = event.pull_request;
  if (!pr) return { skip: 'not a pull request' };
  if (pr.draft) return { skip: 'draft: reviewed when marked ready for review' };
  if (pr.head.repo?.full_name && pr.head.repo.full_name !== repo) return { skip: 'from a fork: not reviewed' };
  if (!TRUSTED.includes(pr.author_association) && !COPILOT.includes(pr.user?.login)) return { skip: `opened by ${pr.author_association}: members and Copilot only` };
  for await (const page of gh.pages(`/repos/${repo}/pulls/${pr.number}/reviews`)) {
    if (page.some((r) => r.user?.login === BOT && r.body?.includes(runMarker(pr.head.sha)))) return { skip: `already reviewed ${pr.head.sha.slice(0, 7)}` };
  }

  const { files } = await prFiles(gh, repo, pr.number);
  const diff = diffText(files);
  const issue = linkedIssues(pr.body)[0];
  const parts = [
    'Review this pull request.',
    wrapUntrusted('untrusted_pr', `Title: ${pr.title}\n\n${pr.body ?? ''}`),
    wrapUntrusted('untrusted_diff', diff.text, MAX_DIFF_CHARS),
  ];
  if (diff.truncated.length) parts.push(`These files are left out of the diff because it's too long: ${diff.truncated.slice(0, 50).join(', ')}.`);
  if (issue) {
    const meta = await gh.get(`/repos/${repo}/issues/${issue}`);
    const steps = issueSteps(gh, repo, issue, meta.labels.map((l) => l.name));
    parts.push(wrapUntrusted('untrusted_issue', `Title: ${meta.title}\n\n${meta.body ?? ''}`));
    const status = await steps.findComment(MARKER);
    if (status) parts.push(wrapUntrusted('untrusted_triage', status.body.replace(MARKER, '')));
    const plan = await steps.findComment(PLAN_MARKER);
    if (plan) parts.push(wrapUntrusted('untrusted_plan', plan.body.replace(/<!-- scaffold:plan-(?:data|scenarios) [^>]* -->/g, '')));
    const scenarios = await approvedScenarios(gh, repo, issue, config);
    if (scenarios.ok) parts.push(wrapUntrusted('untrusted_scenarios', scenariosText(scenarios.comment.body)));
  }
  const precedents = await readRepoFile(gh, repo, 'PRECEDENTS.md', pr.base.sha);
  if (precedents) parts.push(wrapUntrusted('untrusted_precedents', precedents));
  const user = parts.join('\n\n');
  const inputHash = createHash('sha256').update(user).digest('hex').slice(0, 16);

  const { system, schema, version, model } = await loadSkill('code-review');
  let out;
  try {
    out = await callModel({ model, system, user, schema });
  } catch (err) {
    const why = err instanceof RateLimited ? 'Copilot is rate limiting' : 'the model call failed';
    return { lines: [heading, `Skipped: ${why}. Re-run this job to review.`, '', `\`${err.message.slice(0, 500)}\``] };
  }
  const errors = validate(schema, out);
  if (errors.length) return { lines: [heading, 'Invalid output (nothing posted):', '', ...errors.map((x) => `- ${x}`)] };

  // Inline where the line is in the diff; on the file (still a thread the gate waits for) where the file
  // changed but the line isn't in a hunk; in the review body only for files the PR doesn't change.
  const valid = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
  const inline = out.comments.filter((c) => valid.get(c.path)?.has(c.line));
  const onFile = out.comments.filter((c) => !inline.includes(c) && valid.has(c.path));
  const other = out.comments.filter((c) => !valid.has(c.path));
  const audit = [
    heading,
    '| Skill | Version | Model | Input hash | Comments | Inline | Diff truncated |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| code-review | ${version} | ${model} | \`${inputHash}\` | ${out.comments.length} | ${inline.length} | ${diff.truncated.length} files |`,
  ];
  if (!out.comments.length) return { lines: [...audit, '', 'No comments: nothing posted.'] };

  const body = [
    runMarker(pr.head.sha),
    `**SCAFFOLD code-review** of ${pr.head.sha.slice(0, 7)}: ${e(out.summary)}`,
    '',
    ...(other.length ? ['Comments on files this PR doesn\'t change:', '', ...other.map((c) => `- \`${e(c.path)}:${c.line}\` **${c.axis} · ${c.severity}**: ${e(c.body)}`), ''] : []),
    'Resolve each thread once it\'s handled (or reply why not); the review gate waits for them. React 👎 to a comment that is wrong: the usage report counts it as a false positive.',
    '',
    `<sub>code-review v${version} · ${model} · AI-generated: check before acting</sub>`,
  ].join('\n');
  await gh.post(`/repos/${repo}/pulls/${pr.number}/reviews`, {
    commit_id: pr.head.sha,
    event: 'COMMENT',
    body,
    comments: [
      ...inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: commentBody(c) })),
      ...onFile.map((c) => ({ path: c.path, subject_type: 'file', body: `${commentBody(c)}\n\n<sub>Line ${c.line}, outside the diff.</sub>` })),
    ],
  });
  return { lines: audit };
}
