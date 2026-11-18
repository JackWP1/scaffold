// GitHub side effects for triage, with the client injected so tests can fake it.
import { MARKER } from './render.mjs';

const WRITERS = ['admin', 'maintain', 'push', 'write'];

export function issueSteps(gh, repo, number, labels) {
  const base = `/repos/${repo}/issues/${number}`;

  // Keeps `labels` in step with the issue so later calls see earlier changes.
  async function setLabels(add, remove) {
    for (const name of remove.filter((l) => labels.includes(l) && !add.includes(l))) {
      await gh.delete(`${base}/labels/${encodeURIComponent(name)}`);
      labels.splice(labels.indexOf(name), 1);
    }
    if (add.length) {
      await gh.post(`${base}/labels`, { labels: add });
      for (const name of add) if (!labels.includes(name)) labels.push(name);
    }
  }

  async function upsertStatus(body) {
    for await (const comments of gh.pages(`${base}/comments`)) {
      const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
      if (mine) return gh.patch(`/repos/${repo}/issues/comments/${mine.id}`, { body });
    }
    return gh.post(`${base}/comments`, { body });
  }

  // True only if a user with write access applied scaffold:accepted. `sender` is
  // the actor of a `labeled` event; otherwise the latest labeled event is used.
  async function acceptedByMember(sender) {
    let actor = sender;
    if (!actor) {
      for await (const events of gh.pages(`${base}/events`)) {
        for (const e of events) {
          if (e.event === 'labeled' && e.label?.name === 'scaffold:accepted') actor = e.actor;
        }
      }
    }
    if (!actor?.login || actor.type !== 'User') return false;
    try {
      const { permission } = await gh.get(`/repos/${repo}/collaborators/${encodeURIComponent(actor.login)}/permission`);
      return WRITERS.includes(permission);
    } catch {
      return false;
    }
  }

  return { setLabels, upsertStatus, acceptedByMember };
}
