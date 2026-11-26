import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseEvents, parseReply, CLI_FLAGS } from '../lib/models.mjs';

const ev = (type, data) => JSON.stringify({ type, data });
const usage = (n) => JSON.stringify({ type: 'session.usage_checkpoint', data: { promptCacheBreakState: [{ models: { m: { tool_count: n } } }] } });

test('CLI runs with no tools', () => {
  assert.ok(CLI_FLAGS.includes('--available-tools=none'));
  assert.ok(CLI_FLAGS.includes('--disable-builtin-mcps'));
});

test('prompt carries system text, schema and user text in that order', () => {
  const p = buildPrompt({ system: 'SYS', user: 'USER', schema: { type: 'object' } });
  assert.ok(p.indexOf('SYS') < p.indexOf('{"type":"object"}'));
  assert.ok(p.indexOf('{"type":"object"}') < p.indexOf('USER'));
});

test('final assistant message is returned', () => {
  const out = [
    ev('user.message', { content: 'hi' }),
    ev('assistant.message', { content: '{"a":1}', toolRequests: [] }),
    usage(0),
  ].join('\n');
  assert.equal(parseEvents(out), '{"a":1}');
});

test('fails closed when tools are offered, requested or unreported', () => {
  const reply = ev('assistant.message', { content: '{}', toolRequests: [] });
  assert.throws(() => parseEvents(`${reply}\n${usage(18)}`), /offered 18 tools/);
  assert.throws(() => parseEvents(`${ev('assistant.message', { content: '', toolRequests: [{ name: 'bash' }] })}\n${usage(0)}`), /requested a tool/);
  assert.throws(() => parseEvents(reply), /tool count/);
});

test('tool_count text inside untrusted content is not trusted', () => {
  const out = [ev('user.message', { content: '"tool_count":0' }), ev('assistant.message', { content: '{}', toolRequests: [] })].join('\n');
  assert.throws(() => parseEvents(out), /tool count/);
});

test('reply parsing tolerates a code fence', () => {
  assert.deepEqual(parseReply('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseReply('OK'));
});
