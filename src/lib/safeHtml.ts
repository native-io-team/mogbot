/**
 * The one way text from outside the app becomes HTML.
 *
 * Agent replies and agent-to-agent threads are written by agents
 * that have just read repositories and web pages, so their markdown — and any
 * raw HTML inside it — is untrusted. DOMPurify's defaults keep far too much for
 * that: `style` (a reply drawn over an Allow / Deny card), forms and buttons
 * (a fake prompt), `svg`, media, and `<img>`, which loads whatever URL the text
 * names the moment it renders. This allowlist keeps the prose elements and
 * nothing else.
 *
 * Images never load from here. Each becomes a link chip — "Image from
 * example.com" — that opens in the browser when clicked. Files the user
 * attached render inline through their own components (asset protocol), not
 * through this.
 */
import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'br',
  'hr',
  'del',
  's',
];

const ALLOWED_ATTR = ['href', 'title', 'class', 'align', 'start'];

/** Classes the app's own renderers put on markup. Everything else is dropped,
 *  so a message cannot borrow an app class to restyle itself. */
const SAFE_CLASS = /^(?:agent-path|md-image-link|language-[\w-]{1,40})$/;

/** Web links, mail, in-page anchors, and local file paths (absolute, `~`,
 *  relative, a Windows drive). No other scheme survives — `javascript:`,
 *  `data:`, `file:`, `tauri:`, `asset:` all go. */
const ALLOWED_URI = /^(?:https?:|mailto:|[/~.#]|[a-z]:(?:%5c|[\\/])|[^:]*$)/i;

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP: ALLOWED_URI,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** A private DOMPurify instance, so this hook never touches anyone else's
 *  sanitize call. */
let instance: ReturnType<typeof DOMPurify> | null = null;
function purifier(): ReturnType<typeof DOMPurify> {
  if (instance) return instance;
  const purify = DOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'class') return;
    const kept = data.attrValue
      .split(/\s+/)
      .filter((name) => SAFE_CLASS.test(name))
      .join(' ');
    if (kept) data.attrValue = kept;
    else data.keepAttr = false;
  });
  instance = purify;
  return purify;
}

/** What an image's link chip says: the host for a web image, the name for a
 *  local one. */
export function imageLinkLabel(src: string, alt: string): string {
  try {
    const url = new URL(src);
    if (url.protocol === 'http:' || url.protocol === 'https:') return `Image from ${url.host}`;
  } catch {
    // Not absolute: a local path.
  }
  const name = alt.trim() || src.split(/[\\/]/).pop() || 'image';
  return `Image: ${name}`;
}

/** Replace every `<img>` with a link chip. Runs in a DOMParser document, which
 *  never fetches, before anything reaches the live page. */
function imagesToLinks(html: string): string {
  if (!/<img/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const link = doc.createElement('a');
    link.className = 'md-image-link';
    if (src) link.setAttribute('href', src);
    link.textContent = imageLinkLabel(src, img.getAttribute('alt') ?? '');
    img.replaceWith(link);
  }
  return doc.body.innerHTML;
}

/** Sanitize HTML rendered from agent or outside text. */
export function sanitizeMessageHtml(html: string): string {
  return purifier().sanitize(imagesToLinks(html), CONFIG);
}
