// Entry point for the weekly usage report (logic in report.mjs).
import { appendFile } from 'node:fs/promises';
import { github } from '../../lib/github.mjs';
import { tryLoadConfig } from '../../lib/config.mjs';
import { postReport } from './report.mjs';

const gh = github(process.env.GITHUB_TOKEN);
const repo = process.env.GITHUB_REPOSITORY;
const body = await postReport(gh, repo, await tryLoadConfig(gh, repo));
await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${body}\n`);
