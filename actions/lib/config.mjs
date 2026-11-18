// Reads the calling repo's .github/scaffold.yml (PLAN.md section 4) from its default branch.
// A missing file gives the defaults, which list no approvers, so nothing can be approved.

export const DEFAULTS = {
  approvers: [],
  flow_lead: null,
  max_in_flight: 20,
  pr_size: {
    soft: { files: 10, lines: 1000 },
    hard: { files: 30, lines: 5000 },
    exempt: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'dist/**'],
  },
};

// Parses the YAML subset scaffold.yml uses: nested maps, `- item` lists, `[a, b]` lists,
// scalars and comments. Not a general YAML parser.
export function parseYaml(text) {
  const lines = text.split('\n')
    .map((l) => l.replace(/\s+#.*$|^\s*#.*$/, '').trimEnd())
    .filter(Boolean)
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  const scalar = (v) => {
    if (/^-?\d+$/.test(v)) return Number(v);
    if (v === 'true' || v === 'false') return v === 'true';
    if (v === 'null' || v === '~') return null;
    if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map(scalar);
    return v.replace(/^(["'])(.*)\1$/, '$2');
  };
  function block(indent) {
    if (lines[i].text.startsWith('- ')) {
      const list = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) list.push(scalar(lines[i++].text.slice(2).trim()));
      return list;
    }
    const map = {};
    while (i < lines.length && lines[i].indent === indent) {
      const [, key, value] = lines[i++].text.match(/^([\w-]+):\s*(.*)$/) ?? [];
      if (!key) throw new Error(`scaffold.yml: can't parse line ${i}`);
      map[key] = value !== '' ? scalar(value) : i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null;
    }
    return map;
  }
  return lines.length ? block(lines[0].indent) : {};
}

function merge(defaults, value) {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) return value ?? defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value ?? {})) out[k] = merge(defaults[k], v);
  return out;
}

export function configFrom(text) {
  const config = merge(DEFAULTS, parseYaml(text));
  config.approvers = (config.approvers ?? []).map((a) => String(a).toLowerCase());
  return config;
}

// A file from the repo's default branch, or null if it doesn't exist.
export async function readRepoFile(gh, repo, path) {
  try {
    const file = await gh.get(`/repos/${repo}/contents/${path}`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (err) {
    if (String(err.message).includes(': 404 ')) return null;
    throw err;
  }
}

export async function loadConfig(gh, repo) {
  return configFrom((await readRepoFile(gh, repo, '.github/scaffold.yml')) ?? '');
}
