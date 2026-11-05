/**
 * Outside pages the app sends people to, in one place, for the desk and the
 * phone. The Rust side's copy (`agents/logins.rs` `CLAUDE_AI_CONNECTORS`) is
 * held equal to this by a test there; `links.test.ts` holds each one
 * well-formed. How each was verified is recorded in docs/agents.md
 * ("Logins", "Where claude.ai connectors are added").
 */

/**
 * Claude's connectors page (Customize → Connectors), where Gmail, Google
 * Calendar, Google Drive and Slack are connected to the user's Claude
 * account. Verified 2026-11-05 against claude.com/docs/connectors/google/gmail
 * and claude.com/docs/connectors/directory; the old `/settings/connectors`
 * page now says it moved to Customize. No link to one connector is
 * documented, so the card names the connector to look for.
 */
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/customize/connectors';

/** Every outside link above, for the well-formedness test. */
export const OUTSIDE_LINKS: readonly string[] = [CLAUDE_AI_CONNECTORS_URL];
