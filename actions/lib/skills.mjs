// Loads a skill's prompt, output schema, version and model (PLAN.md section 3).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillBody } from './text.mjs';

export async function loadSkill(root, name, modelOverride) {
  const skillMd = await readFile(join(root, `skills/${name}/SKILL.md`), 'utf8');
  const manifest = await readFile(join(root, 'skills/manifest.yml'), 'utf8');
  const models = await readFile(join(root, 'config/models.yml'), 'utf8');
  const entry = manifest.match(new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n?)+)`, 'm'))[1];
  const field = (key) => entry.match(new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'm'))[1];
  const tier = field('tier');
  return {
    system: skillBody(skillMd),
    schema: JSON.parse(await readFile(join(root, field('schema')), 'utf8')),
    version: field('version'),
    model: modelOverride || models.match(new RegExp(`^${tier}:\\s*(\\S+)`, 'm'))[1],
  };
}
