#!/usr/bin/env node
/**
 * Points the releases repo README's download link at a new DMG, for
 * scripts/release-mac.sh --publish.
 *
 *   gh api repos/<repo>/contents/README.md --jq .content \
 *     | LABEL="App 1.0.1 for Mac (Apple Silicon)" URL="https://…/App_1.0.1_aarch64.dmg" \
 *       node scripts/release-readme-link.mjs
 *
 * Reads the README as GitHub's contents API gives it (base64, wrapped) on
 * stdin and prints the new README, base64, on stdout. The link it replaces is
 * the one bold link right under "## Download". Exit 2 (nothing printed) when
 * there is no such link, so the caller says so instead of guessing.
 */
import { fileURLToPath } from 'node:url';

export function replaceDownloadLink(text, label, url) {
  const re = /(## Download[ \t]*\r?\n(?:[ \t]*\r?\n)*)\*\*\[[^\]\n]*\]\([^)\n]*\)\*\*/;
  if (!re.test(text)) return null;
  return text.replace(re, (_, head) => `${head}**[${label}](${url})**`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { LABEL, URL } = process.env;
  if (!LABEL || !URL) {
    console.error('LABEL and URL are required');
    process.exit(1);
  }
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const text = Buffer.from(input.replace(/\s+/g, ''), 'base64').toString('utf8');
    const next = replaceDownloadLink(text, LABEL, URL);
    if (next === null) {
      console.error('no bold link under "## Download"');
      process.exit(2);
    }
    process.stdout.write(Buffer.from(next, 'utf8').toString('base64'));
  });
}
