// The toolbar popup: what the link is doing, in one line, and this
// profile's name.

const LINES = {
  connected: 'Connected to the app. Your agents can use this Chrome.',
  connecting: 'Connecting to the app…',
  app_not_running: 'The app isn’t running on this Mac. Open it, and this connects by itself.',
  no_host:
    'The app hasn’t set this Chrome up yet. In the app, open Settings → Chrome → Your Chrome and turn it on.',
  update_needed: 'This extension and the app are different versions. Update the one that’s older.',
  refused:
    'The app and this extension couldn’t confirm each other. Turn Your Chrome off and on in the app.',
  stopped: 'Turned off in the app (Settings → Chrome → Your Chrome).',
};

const $ = (id) => document.getElementById(id);

// The app's name comes from the manifest (itself checked against brand.json).
const NAME = chrome.runtime.getManifest().short_name;
document.title = NAME;
$('name').textContent = NAME;

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  if (!s) return;
  $('state').textContent = LINES[s.state] || s.state;
  $('detail').textContent =
    s.state === 'connected' && s.agentTabs
      ? `${s.agentTabs} agent tab${s.agentTabs === 1 ? '' : 's'} open.`
      : '';
  if (document.activeElement !== $('label')) $('label').value = s.label || '';
}

$('save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'label', label: $('label').value.trim() });
  await refresh();
});
$('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => void refresh(), 800);
});

void refresh();
setInterval(() => void refresh(), 2000);
