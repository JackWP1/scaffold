// Helpers for handling untrusted text in prompts and comments (PLAN.md section 6).

export const MAX_INPUT_CHARS = 20000;

// Wrap untrusted text so it can't close the delimiter early. `max` caps its length (a diff needs more).
export function wrapUntrusted(tag, text, max = MAX_INPUT_CHARS) {
  const clean = String(text ?? '').slice(0, max).replaceAll(`</${tag}>`, `<\\/${tag}>`);
  return `<${tag}>\n${clean}\n</${tag}>`;
}

// Neutralise @-mentions, HTML and markdown links/images in model output before posting.
export function escapeForComment(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/@(?=[A-Za-z0-9-_/])/g, '@​')
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/(https?):\/\//gi, '$1​://')
}

// Strip YAML frontmatter from a SKILL.md.
export function skillBody(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}
