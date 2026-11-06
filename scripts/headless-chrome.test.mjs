import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanPids } from './headless-chrome.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PS = [
  // Ours, orphaned: swept.
  `  101     1 ${CHROME} --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/x/shipstudio-cdp-harness-9333-55`,
  // Ours, but its run is still alive (parent 55): left alone.
  `  102    55 ${CHROME} --headless=new --user-data-dir=/tmp/x/shipstudio-cdp-harness-9334-55`,
  // A renderer of ours: not the browser process, left to die with it.
  `  103   101 ${CHROME} Helper (Renderer) --type=renderer --user-data-dir=/tmp/x/shipstudio-cdp-harness-9333-55`,
  // The person's own Chrome: never.
  `  104     1 ${CHROME}`,
  // Another tool's: not this sweep's.
  `  105     1 ${CHROME} --headless=new --user-data-dir=/tmp/x/shipstudio-cdp-fidelity-9400-9`,
  // The fixed profile an older harness used, orphaned: swept via legacy.
  `  106     1 ${CHROME} --headless=new --user-data-dir=/tmp/x/shipstudio-harness-chrome about:blank`,
  // qa:web's, and an older qa:web's (…/qa-web-XXXX/chrome).
  `  107     1 ${CHROME} --headless=new --user-data-dir=/tmp/qa-web-a1/shipstudio-cdp-qa-web-chrome`,
  `  108     1 ${CHROME} --headless=new --user-data-dir=/tmp/qa-web-b2/chrome --no-first-run`,
].join('\n');

test('only orphaned headless browsers this tool started are swept', () => {
  assert.deepEqual(orphanPids(PS, 'harness', [], 999), [101]);
  assert.deepEqual(orphanPids(PS, 'harness', [/shipstudio-harness-chrome/], 999), [101, 106]);
  assert.deepEqual(orphanPids(PS, 'qa-web', [/qa-web-[^/\s]+\/chrome(\s|$)/], 999), [107, 108]);
  assert.deepEqual(orphanPids(PS, 'harness', [], 101), [], 'never itself');
});
