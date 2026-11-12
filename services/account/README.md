# account.mogbot.app

The sign-in page on the product's own domain, so Clerk (production) runs first-party on
mogbot.app. Nothing is hosted here: Vercel proxies `/link` to the relay's `/account/link`
and `/v1/link` to the relay's `/v1/link`, so the page and its POST are same-origin.
The relay's own `/link` redirects here when it is deployed with `--link-origin`
(see `services/relay/scripts/deploy.mjs`).

Deploy: `vercel deploy --prod` in this folder (Vercel project `mogbot-account`, team Native),
domain `account.mogbot.app` (Vercel DNS).
