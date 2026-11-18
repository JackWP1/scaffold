// Creates or updates the SCAFFOLD labels from config/labels.yml in the calling repo.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { github } from '../lib/github.mjs';
import { parseLabels } from '../lib/labels.mjs';

async function main() {
  const gh = github(process.env.GITHUB_TOKEN);
  const repo = process.env.GITHUB_REPOSITORY;
  const labels = parseLabels(await readFile(join(process.env.SCAFFOLD_ROOT, 'config/labels.yml'), 'utf8'));
  for (const label of labels) {
    try {
      await gh.post(`/repos/${repo}/labels`, label);
      console.log(`created ${label.name}`);
    } catch (err) {
      if (!String(err.message).includes(': 422 ')) throw err;
      await gh.patch(`/repos/${repo}/labels/${encodeURIComponent(label.name)}`, { color: label.color, description: label.description });
      console.log(`updated ${label.name}`);
    }
  }
}

await main();
