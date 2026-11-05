import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { imageLinkLabel, sanitizeMessageHtml } from './safeHtml';

const render = (md: string) => sanitizeMessageHtml(String(marked.parse(md, { async: false })));

describe('sanitizeMessageHtml — payloads from the security review', () => {
  it('turns a remote image into a link chip instead of loading it', () => {
    const html = render('<img src="https://evil.example/b.png?x=1">');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('class="md-image-link"');
    expect(html).toContain('href="https://evil.example/b.png?x=1"');
    expect(html).toContain('Image from evil.example');
  });

  it('turns markdown images into link chips too', () => {
    const html = render('![chart](https://cdn.example.com/c.png)');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('Image from cdn.example.com');
  });

  it('drops forms, inputs and buttons', () => {
    const html = render(
      '<form action="https://evil.example/steal"><input name="pin"><button>Allow</button></form>'
    );
    expect(html).not.toMatch(/<form|<input|<button|action=/i);
  });

  it('drops inline style, so nothing can overlay an approval card', () => {
    const html = render(
      '<div style="position:fixed;inset:0;z-index:99999;background:#000">Click Allow</div>'
    );
    expect(html).not.toMatch(/style=|position/i);
    expect(html).toContain('Click Allow');
  });

  it('drops iframes, objects, embeds, svg, media and scripts', () => {
    const html = render(
      [
        '<iframe src="https://evil.example"></iframe>',
        '<object data="x.swf"></object>',
        '<embed src="x">',
        '<svg onload="alert(1)"><circle r="9"/></svg>',
        '<video src="v.mp4"></video><audio src="a.mp3"></audio>',
        '<script>alert(1)</script>',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        '<style>body{display:none}</style>',
      ].join('\n')
    );
    expect(html).not.toMatch(/<(iframe|object|embed|svg|video|audio|script|link|style)/i);
  });

  it('drops dangerous schemes and event handlers but keeps web, mail and path links', () => {
    expect(render('[x](javascript:alert(1))')).not.toMatch(/javascript/i);
    expect(render('<a href="data:text/html,hi">x</a>')).not.toMatch(/data:/i);
    expect(render('<a href="tauri://localhost/">x</a>')).not.toMatch(/tauri:/i);
    expect(render('<a href="file:///etc/passwd">x</a>')).not.toMatch(/file:/i);
    expect(render('<p onclick="alert(1)">x</p>')).not.toMatch(/onclick/i);
    expect(render('[w](https://example.com)')).toContain('href="https://example.com"');
    expect(render('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
    expect(render('<a href="/Users/me/report.pdf">r</a>')).toContain('href="/Users/me/report.pdf"');
  });

  it('keeps only the app’s own classes, and no ids', () => {
    const html = render('<p class="agent-approval modal-overlay" id="root">x</p>');
    expect(html).toBe('<p>x</p>');
    expect(sanitizeMessageHtml('<a class="agent-path evil" href="/a">a</a>')).toBe(
      '<a class="agent-path" href="/a">a</a>'
    );
    expect(render('```js\nx\n```')).toContain('class="language-js"');
  });

  it('keeps ordinary prose', () => {
    const html = render(
      '# Title\n\n**b** _i_ ~~d~~ `c`\n\n> q\n\n- a\n- b\n\n| h |\n|---|\n| v |\n\n---'
    );
    for (const tag of [
      'h1',
      'strong',
      'em',
      'del',
      'code',
      'blockquote',
      'ul',
      'li',
      'table',
      'td',
      'hr',
    ]) {
      expect(html).toContain(`<${tag}`);
    }
  });

  it('does not change DOMPurify for anyone else', () => {
    sanitizeMessageHtml('<p class="x">x</p>');
    expect(DOMPurify.sanitize('<p class="x">x</p>')).toBe('<p class="x">x</p>');
  });
});

describe('imageLinkLabel', () => {
  it('names the host for web images and the file for local ones', () => {
    expect(imageLinkLabel('https://a.example.com/x.png', 'alt')).toBe('Image from a.example.com');
    expect(imageLinkLabel('/Users/me/shot.png', '')).toBe('Image: shot.png');
    expect(imageLinkLabel('shot.png', 'Screenshot')).toBe('Image: Screenshot');
  });
});
