// Single-shot model call through GitHub Copilot CLI, returning parsed JSON (PLAN.md section 2).
// GitHub Models was retired on 2026-07-30. Copilot CLI is an agent, so it runs with no tools,
// MCP servers or repo instructions, and the call fails closed if any tool is offered or requested.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class RateLimited extends Error {}

export const CLI_FLAGS = [
  '--available-tools=none',
  '--disable-builtin-mcps',
  '--no-custom-instructions',
  '--no-ask-user',
  '--no-auto-update',
  '--output-format', 'json',
];

// Copilot CLI has no system role or response_format, so both go in the one prompt.
export function buildPrompt({ system, user, schema }) {
  return [
    system,
    '## Output format',
    'Reply with a single JSON object that matches this JSON Schema. No prose and no code fences.',
    JSON.stringify(schema),
    '---',
    user,
  ].join('\n\n');
}

// Reads the CLI's JSONL event stream and returns the final reply text.
export function parseEvents(jsonl) {
  let content;
  let toolCounts = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    // Matches the CLI's own fields only: the same text inside a JSON string has escaped quotes.
    for (const [, n] of line.matchAll(/"tool_count":(\d+)/g)) {
      if (Number(n) !== 0) throw new Error(`Copilot CLI offered ${n} tools to the model`);
      toolCounts++;
    }
    const event = JSON.parse(line);
    if (event.type !== 'assistant.message') continue;
    if (event.data?.toolRequests?.length) throw new Error('Copilot CLI model requested a tool');
    content = event.data?.content;
  }
  if (!toolCounts) throw new Error('Copilot CLI did not report its tool count');
  if (typeof content !== 'string') throw new Error('Copilot CLI returned no reply');
  return content;
}

// Tolerates a code fence around the JSON, which strict output used to rule out.
export function parseReply(text) {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
}

export async function callModel({ token, model, system, user, schema, timeoutMs = 180_000 }) {
  const args = ['-p', buildPrompt({ system, user, schema }), '--model', model, ...CLI_FLAGS];
  // An empty working directory keeps the repo out of the CLI's context.
  const cwd = await mkdtemp(join(tmpdir(), 'scaffold-'));
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn('copilot', args, { cwd, env: { ...process.env, GITHUB_TOKEN: token }, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  if (code !== 0) {
    const detail = `${stderr}\n${stdout}`.trim().slice(-1000);
    if (/rate.?limit|429/i.test(detail)) throw new RateLimited('Copilot rate limit');
    throw new Error(`Copilot CLI exited ${code}: ${detail}`);
  }
  return parseReply(parseEvents(stdout));
}
