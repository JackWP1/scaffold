// GitHub side effects on one issue, with the client injected so tests can fake it.
import { MARKER } from './status.mjs';

const WRITERS = ['admin', 'maintain', 'push', 'write'];
const BOT = 'github-actions[bot]';

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

  // The SCAFFOLD comment starting with `marker`, or undefined. Only the Actions bot's comments count.
  async function findComment(marker) {
    for await (const comments of gh.pages(`${base}/comments`)) {
      const mine = comments.find((c) => c.user?.login === BOT && c.body?.startsWith(marker));
      if (mine) return mine;
    }
  }

  async function findComments(marker) {
    const all = [];
    for await (const comments of gh.pages(`${base}/comments`)) {
      all.push(...comments.filter((c) => c.user?.login === BOT && c.body?.startsWith(marker)));
    }
    return all;
  }

  async function upsertComment(marker, body) {
    const mine = await findComment(marker);
    if (mine) return gh.patch(`/repos/${repo}/issues/comments/${mine.id}`, { body });
    return gh.post(`${base}/comments`, { body });
  }

  const upsertStatus = (body) => upsertComment(MARKER, body);

  async function events() {
    const all = [];
    for await (const page of gh.pages(`${base}/events`)) all.push(...page);
    return all;
  }

  async function hasWriteAccess(actor) {
    if (!actor?.login || actor.type !== 'User') return false;
    try {
      const { permission } = await gh.get(`/repos/${repo}/collaborators/${encodeURIComponent(actor.login)}/permission`);
      return WRITERS.includes(permission);
    } catch {
      return false;
    }
  }

  // True only if a user with write access applied scaffold:accepted. `sender` is
  // the actor of a `scaffold:accepted` labeled event; otherwise the latest such event is used.
  async function acceptedByMember(sender) {
    let actor = sender;
    if (!actor) {
      for (const e of await events()) {
        if (e.event === 'labeled' && e.label?.name === 'scaffold:accepted') actor = e.actor;
      }
    }
    return hasWriteAccess(actor);
  }

  return { setLabels, findComment, findComments, upsertComment, upsertStatus, events, acceptedByMember };
}
