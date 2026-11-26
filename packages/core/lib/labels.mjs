// Parses the flat list-of-maps format used by config/labels.yml.
export function parseLabels(yaml) {
  const labels = [];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(-\s+|\s+)(\w+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].startsWith('-')) labels.push({});
    labels.at(-1)[m[2]] = m[3].replace(/^"(.*)"$/, '$1');
  }
  return labels;
}
