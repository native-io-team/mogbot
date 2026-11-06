/**
 * A login's key as words a person reads: "email_drafts" → "Email drafts",
 * "crm_api_key" → "CRM API key", "github_workshop" → "GitHub workshop".
 *
 * Sentence case, like every other title here, with the names people know
 * spelled the way their makers spell them. The Mac says the same
 * (`agents::team_setup::humanise`); both are held to `login-names.json`, which
 * has a case for every name in either map, so the desk, the phone and the
 * Mac never title one login two ways.
 */

/** Lower-case word → how it's written. Brands as their makers write them, acronyms in capitals. */
export const KNOWN_NAMES: Readonly<Record<string, string>> = {
  // Apps people sign in to.
  airtable: 'Airtable',
  asana: 'Asana',
  calendly: 'Calendly',
  discord: 'Discord',
  dropbox: 'Dropbox',
  facebook: 'Facebook',
  figma: 'Figma',
  github: 'GitHub',
  gitlab: 'GitLab',
  gmail: 'Gmail',
  google: 'Google',
  hubspot: 'HubSpot',
  instagram: 'Instagram',
  intercom: 'Intercom',
  jira: 'Jira',
  linear: 'Linear',
  linkedin: 'LinkedIn',
  mailchimp: 'Mailchimp',
  netlify: 'Netlify',
  notion: 'Notion',
  openai: 'OpenAI',
  paypal: 'PayPal',
  pipedrive: 'Pipedrive',
  quickbooks: 'QuickBooks',
  salesforce: 'Salesforce',
  sendgrid: 'SendGrid',
  shopify: 'Shopify',
  slack: 'Slack',
  stripe: 'Stripe',
  telegram: 'Telegram',
  tiktok: 'TikTok',
  trello: 'Trello',
  twilio: 'Twilio',
  twitter: 'Twitter',
  vercel: 'Vercel',
  webflow: 'Webflow',
  whatsapp: 'WhatsApp',
  wordpress: 'WordPress',
  x: 'X',
  xero: 'Xero',
  youtube: 'YouTube',
  zendesk: 'Zendesk',
  zoom: 'Zoom',
  // Acronyms.
  ai: 'AI',
  api: 'API',
  aws: 'AWS',
  cms: 'CMS',
  crm: 'CRM',
  db: 'DB',
  id: 'ID',
  ios: 'iOS',
  oauth: 'OAuth',
  pat: 'PAT',
  seo: 'SEO',
  sms: 'SMS',
  smtp: 'SMTP',
  sql: 'SQL',
  ssh: 'SSH',
  url: 'URL',
};

/**
 * Two words that are one known name split by camel case or a separator
 * ("linkedIn", "git_hub", "hubSpot"): joined back before casing.
 */
function joinSplitNames(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? words[i] + words[i + 1] : '';
    if (pair && KNOWN_NAMES[pair] !== undefined && KNOWN_NAMES[words[i]] === undefined) {
      out.push(pair);
      i++;
    } else {
      out.push(words[i]);
    }
  }
  return out;
}

export function humanise(key: string): string {
  const words = key
    .trim()
    // "emailDrafts" → "email Drafts"; "CRMToken" → "CRM Token".
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return 'A login';
  // Index, not rest destructuring: the phone's Jest build would need a runtime helper for it.
  const joined = joinSplitNames(words);
  const first = joined[0];
  // A known name keeps its own first letter ("iOS app"); any other word opens the sentence.
  const opening = KNOWN_NAMES[first] ?? first[0].toUpperCase() + first.slice(1);
  return [opening].concat(joined.slice(1).map((w) => KNOWN_NAMES[w] ?? w)).join(' ');
}
