// Tiny GitHub REST client using GITHUB_TOKEN and fetch (Node 20+).
export function github(token, api = process.env.GITHUB_API_URL || 'https://api.github.com') {
  async function request(method, path, body) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'DELETE') return null;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  // Yields pages of a list endpoint until a short page; stop early by breaking.
  async function* pages(path) {
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const items = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      yield items;
      if (items.length < 100) return;
    }
  }
  // Binary download (e.g. an artifact zip). GitHub redirects to short-lived storage: the token is sent
  // to GitHub only, never to the redirect target.
  async function download(path) {
    const res = await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'manual' });
    const target = res.status >= 300 && res.status < 400 ? await fetch(res.headers.get('location')) : res;
    if (!target.ok) throw new Error(`GET ${path}: ${target.status}`);
    return Buffer.from(await target.arrayBuffer());
  }
  return {
    request,
    download,
    pages,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    delete: (p) => request('DELETE', p),
  };
}
