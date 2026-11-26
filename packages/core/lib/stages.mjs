// Package switches (PLAN.md section 5): `stages` in scaffold-config.yml turns each package on or off.
import { configFrom, readRepoFile, stageOn, CONFIG_PATH } from './config.mjs';

export const MAX_HISTORY = 30;

// When `stage` was last turned on: the date of the oldest commit in the latest unbroken run of
// scaffold-config.yml commits with it on (an invalid or missing file counts as off). Returns null when
// every commit checked has it on and there may be older ones, so gates apply to every issue (fail closed).
export async function stageOnSince(gh, repo, stage) {
  const commits = await gh.get(`/repos/${repo}/commits?path=${encodeURIComponent(CONFIG_PATH)}&per_page=${MAX_HISTORY}`);
  let since = null;
  for (const c of commits) {
    let on = false;
    try {
      on = stageOn(configFrom((await readRepoFile(gh, repo, CONFIG_PATH, c.sha)) ?? ''), stage);
    } catch {
      // Invalid at this commit: the package couldn't run, so it was off.
    }
    if (!on) return since;
    since = c.commit.committer.date;
  }
  return commits.length < MAX_HISTORY ? since : null;
}

// True if the issue entered a stage, by `label` being applied, before `since`: it was past the
// stage's entry when the package was turned on, so the package leaves it to be finished by hand.
export function enteredBefore(events, label, since) {
  if (!since) return false;
  const entered = events.filter((e) => e.event === 'labeled' && e.label?.name === label).at(-1);
  return Boolean(entered) && Date.parse(entered.created_at) < Date.parse(since);
}
