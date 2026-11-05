/**
 * A secret's name as a person says it, on the desk and the phone alike:
 * `stripe_key` → "Stripe key", `crm_api_key` → "CRM API key",
 * `github_token` → "GitHub token". The name is the agent's own identifier;
 * a card never shows it raw ("Crm api key", “crm_api_key”).
 */

/** Words that keep their own capitals: initialisms, and brands that have them. */
const SPOKEN: Record<string, string> = {
  api: 'API',
  ats: 'ATS',
  crm: 'CRM',
  url: 'URL',
  id: 'ID',
  ssh: 'SSH',
  smtp: 'SMTP',
  imap: 'IMAP',
  sms: 'SMS',
  aws: 'AWS',
  gcp: 'GCP',
  oauth: 'OAuth',
  jwt: 'JWT',
  pin: 'PIN',
  totp: 'TOTP',
  github: 'GitHub',
  gitlab: 'GitLab',
  openai: 'OpenAI',
  hubspot: 'HubSpot',
  linkedin: 'LinkedIn',
};

/** A word the agent already cased its own way ("QuickBooks"): neither all lower nor all upper. */
const ownCasing = (w: string) => w !== w.toLowerCase() && w !== w.toUpperCase();

export function secretTitle(name: string): string {
  const words = name.split(/[_\-\s]+/).filter(Boolean);
  if (words.length === 0) return name;
  const said = words.map((w) => SPOKEN[w.toLowerCase()] ?? (ownCasing(w) ? w : w.toLowerCase()));
  // No destructuring: the phone's tests compile this file where @babel/runtime
  // can't be resolved, and a rest pattern needs one of its helpers.
  said[0] = said[0].charAt(0).toUpperCase() + said[0].slice(1);
  return said.join(' ');
}
