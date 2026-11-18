// Fake client: `routes` maps a path prefix to a response (or a function of the path).
export function fakeGh(routes = {}) {
  const calls = [];
  const respond = (method, path, body) => {
    calls.push([method, path, body]);
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const r = routes[key];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(path) : r ?? null;
  };
  return {
    calls,
    get: async (p) => respond('GET', p),
    post: async (p, b) => respond('POST', p, b),
    patch: async (p, b) => respond('PATCH', p, b),
    delete: async (p) => respond('DELETE', p),
    async *pages(p) {
      for (let page = 1; ; page++) {
        const items = respond('GET', `${p}?page=${page}`);
        yield items;
        if (items.length < 100) return;
      }
    },
  };
}
