// Single-shot GitHub Models call returning parsed JSON (PLAN.md section 2).
import { toStrictSchema } from './validate.mjs';

export class RateLimited extends Error {}

export async function callModel({ token, model, system, user, schemaName, schema, endpoint = 'https://models.github.ai/inference/chat/completions', retries = 2 }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema: toStrictSchema(schema) },
    },
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      if (attempt >= retries) throw new RateLimited('GitHub Models rate limit');
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    return JSON.parse(content);
  }
}
