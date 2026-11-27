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
const STANDARDS = ['CODING_STANDARDS.md', 'CONTRIBUTING.md', 'PRECEDENTS.md'];
// PR events that can bring a new head commit (or end a draft); labels and edits don't.
const HEAD_EVENTS = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
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
  if (!HEAD_EVENTS.includes(event.action)) return { skip: `${event.action}: only a new head commit is reviewed` };
  if (pr.draft) return { skip: 'draft: reviewed when marked ready for review' };
  if (pr.head.repo?.full_name && pr.head.repo.full_name !== repo) return { skip: 'from a fork: not reviewed' };
  if (!TRUSTED.includes(pr.author_association) && !COPILOT.includes(pr.user?.login)) return { skip: `opened by ${pr.author_association}: members and Copilot only` };
  for await (const page of gh.pages(`/repos/${repo}/pulls/${pr.number}/reviews`)) {
    if (page.some((r) => r.user?.login === BOT && r.body?.includes(runMarker(pr.head.sha)))) return { skip: `already reviewed ${pr.head.sha.slice(0, 7)}` };
  }

  // GitHub lists at most 3000 files: past that, the review says it didn't see them all.
  const { files, truncated: tooMany } = await prFiles(gh, repo, pr.number);
  const diff = diffText(files);
  const issue = linkedIssues(pr.body)[0];
  const parts = [
    'Review this pull request.',
    wrapUntrusted('untrusted_pr', `Title: ${pr.title}\n\n${pr.body ?? ''}`),
    wrapUntrusted('untrusted_diff', diff.text, MAX_DIFF_CHARS),
  ];
  // File names come from the PR, so they stay inside an untrusted wrapper.
  if (tooMany) parts.push('The PR changes more than 3000 files: only the first 3000 are listed, and the rest are not reviewed.');
  if (diff.truncated.length) parts.push('These files are left out of the diff because it\'s too long:', wrapUntrusted('untrusted_left_out_files', diff.truncated.slice(0, 50).join('\n')));
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
  // The repo's documented standards, from the base commit so a PR can't rewrite what it's reviewed against.
  const standards = [];
  for (const path of STANDARDS) {
    const text = await readRepoFile(gh, repo, path, pr.base.sha);
    if (text) standards.push(`## ${path}\n\n${text}`);
  }
  if (standards.length) parts.push(wrapUntrusted('untrusted_standards', standards.join('\n\n')));
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
    `| code-review | ${version} | ${model} | \`${inputHash}\` | ${out.comments.length} | ${inline.length} | ${diff.truncated.length} files${tooMany ? '; over 3000 files, the rest unlisted' : ''} |`,
  ];
  // A clean review is posted too: it records that this commit was reviewed, so it isn't reviewed again.
  const body = [
    runMarker(pr.head.sha),
    `**SCAFFOLD code-review** of ${pr.head.sha.slice(0, 7)}: ${e(out.summary)}${out.comments.length ? '' : ' No comments.'}`,
    '',
    ...(tooMany || diff.truncated.length ? [`⚠️ Partial review: ${tooMany ? 'the PR changes more than 3000 files, so only the first 3000 were listed; ' : ''}${diff.truncated.length} file${diff.truncated.length === 1 ? '' : 's'} left out of the diff because it's too long. A human reviews the rest.`, ''] : []),
    ...(other.length ? ['Comments on files this PR doesn\'t change:', '', ...other.map((c) => `- \`${e(c.path)}:${c.line}\` **${c.axis} · ${c.severity}**: ${e(c.body)}`), ''] : []),
    ...(out.comments.length ? ['Resolve each thread once it\'s handled (or reply why not); the review gate waits for them. React 👎 to a comment that is wrong: the usage report counts it as a false positive.', ''] : []),
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
