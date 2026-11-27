// Reads the calling repo's .github/scaffold-config.yml (PLAN.md sections 4 and 5) from its default branch.
// A missing file gives the defaults, which list no approvers and turn every package off.
// An invalid file throws ConfigError: callers block planning and approval rather than fall back,
// since defaults could quietly loosen a limit (PLAN.md section 6).
import { readFileSync } from 'node:fs';
import { validate } from './validate.mjs';

export class ConfigError extends Error {}

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/scaffold-config.schema.json', import.meta.url), 'utf8'));
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// `bdd.workflow` is a file in .github/workflows/; `bdd.artifact` an Actions artifact name.
const WORKFLOW_FILE = /^[\w.-]+\.ya?ml$/;
const ARTIFACT = /^[\w.-]+$/;

// Workflow stages, in order. Each is a package that `stages` turns on; one not listed is off.
export const PACKAGES = ['intake', 'plan', 'implement', 'review', 'collaboration'];
// Packages in this release. Turning on any other is a config error (PLAN.md section 5).
export const RELEASED = ['intake', 'plan', 'implement', 'review', 'collaboration'];

// Settings whose change needs a listed approver's review (scaffold-config-guard, PLAN.md section 4).
export const PROTECTED = ['stages', 'approvers', 'gherkin', 'bdd', 'ci_workflows', 'max_in_flight', 'max_stack_prs', 'warn_open_prs_per_developer', 'max_rework_rounds', 'pr_size'];

export const DEFAULTS = {
  stages: {},
  approvers: [],
  flow_lead: null,
  gherkin: 'off',
  ci_workflows: [],
  max_in_flight: 20,
  max_stack_prs: 5,
  warn_open_prs_per_developer: 2,
  max_rework_rounds: 6,
  pr_size: {
    soft: { files: 10, lines: 1000 },
    hard: { files: 30, lines: 5000 },
    exempt: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'dist/**'],
  },
};

// Parses the YAML subset scaffold-config.yml uses: nested maps, `- item` lists, `[a, b]` lists,
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
      if (!key) throw new Error(`can't parse line ${i}`);
      map[key] = value !== '' ? scalar(value) : i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null;
    }
    return map;
  }
  return lines.length ? block(lines[0].indent) : {};
}

const isMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Fills in defaults; a value of the wrong shape is kept as is so validation reports it.
// Defaults fill missing keys only: an explicit null is kept so validation rejects it.
function merge(defaults, value) {
  if (!isMap(defaults) || !isMap(value)) return value === undefined ? defaults : value;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(value ?? {})) out[k] = merge(defaults[k], v);
  return out;
}

export function configFrom(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(err.message);
  }
  if (!isMap(raw)) throw new ConfigError('expected a map of settings');
  const config = merge(DEFAULTS, raw);
  const { flow_lead: flowLead, ...rest } = config;
  const errors = validate(SCHEMA, flowLead === null ? rest : config);
  if (!errors.length) {
    for (const [i, a] of config.approvers.entries()) if (!LOGIN.test(a)) errors.push(`$.approvers[${i}]: not a GitHub login`);
    if (flowLead !== null && !LOGIN.test(flowLead)) errors.push('$.flow_lead: not a GitHub login');
    for (const [i, x] of config.pr_size.exempt.entries()) if (!x.trim()) errors.push(`$.pr_size.exempt[${i}]: empty`);
    for (const k of ['files', 'lines']) {
      if (config.pr_size.soft[k] > config.pr_size.hard[k]) errors.push(`$.pr_size.soft.${k}: more than pr_size.hard.${k}`);
    }
    // Scenarios need the runner report the scenarios check reads (PLAN.md section 2, Scenarios).
    if (config.gherkin !== 'off' && config.bdd === undefined) errors.push(`$.bdd: required unless gherkin is off`);
    if (config.bdd) {
      if (!WORKFLOW_FILE.test(config.bdd.workflow)) errors.push('$.bdd.workflow: not a workflow file name, e.g. ci.yml');
      if (!ARTIFACT.test(config.bdd.artifact)) errors.push('$.bdd.artifact: not an artifact name');
    }
    for (const [i, w] of config.ci_workflows.entries()) if (!WORKFLOW_FILE.test(w)) errors.push(`$.ci_workflows[${i}]: not a workflow file name, e.g. ci.yml`);
    for (const [stage, on] of Object.entries(config.stages)) {
      if (on && !RELEASED.includes(stage)) errors.push(`$.stages.${stage}: not released yet; set it to false`);
    }
  }
  if (errors.length) throw new ConfigError(errors.join('; '));
  config.approvers = config.approvers.map((a) => a.toLowerCase());
  return config;
}

// The approvers from a file that fails validation, so the guard can still ask them to review the fix.
// Null unless `approvers` parses as a non-empty list of GitHub logins.
export function approversFrom(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  const list = isMap(raw) ? raw.approvers : null;
  if (!Array.isArray(list) || !list.length || !list.every((a) => typeof a === 'string' && LOGIN.test(a))) return null;
  return list.map((a) => a.toLowerCase());
}

// A file from the repo's default branch (or `ref`), or null if it doesn't exist.
export async function readRepoFile(gh, repo, path, ref) {
  try {
    const file = await gh.get(`/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (err) {
    if (String(err.message).includes(': 404 ')) return null;
    throw err;
  }
}

export const CONFIG_PATH = '.github/scaffold-config.yml';

export async function loadConfig(gh, repo, ref) {
  return configFrom((await readRepoFile(gh, repo, CONFIG_PATH, ref)) ?? '');
}

// { config } or { configError } for callers that report an invalid file rather than throw.
export async function tryLoadConfig(gh, repo, ref) {
  try {
    return { config: await loadConfig(gh, repo, ref) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { configError: err.message };
  }
}

export const stageOn = (config, stage) => config?.stages?.[stage] === true;
