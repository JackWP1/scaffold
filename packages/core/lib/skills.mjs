// Loads a skill's prompt, output schema, version and model (PLAN.md section 3).
// Skills live in the package that uses them: <package>/skills/<name>/SKILL.md, with the version and
// schema in <package>/skills/manifest.yml. Tiers map to models in core's config/models.yml.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillBody } from './text.mjs';

const MODELS = fileURLToPath(new URL('../config/models.yml', import.meta.url));

export async function loadSkill(packageDir, name, modelOverride) {
  const skillMd = await readFile(join(packageDir, `skills/${name}/SKILL.md`), 'utf8');
  const manifest = await readFile(join(packageDir, 'skills/manifest.yml'), 'utf8');
  const models = await readFile(MODELS, 'utf8');
  const entry = manifest.match(new RegExp(`^${name}:\\n((?:[ \\t]+.*\\n?)+)`, 'm'))[1];
  const field = (key) => entry.match(new RegExp(`^\\s+${key}:\\s*(\\S+)`, 'm'))[1];
  const tier = field('tier');
  return {
    system: skillBody(skillMd),
    schema: JSON.parse(await readFile(join(packageDir, field('schema')), 'utf8')),
    version: field('version'),
    model: modelOverride || models.match(new RegExp(`^${tier}:\\s*(\\S+)`, 'm'))[1],
  };
}
