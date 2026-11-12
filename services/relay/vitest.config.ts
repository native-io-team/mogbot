import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Clerk's Backend API is faked in the tests (accounts.test.ts).
      miniflare: { bindings: { CLERK_SECRET_KEY: 'sk_test_fake', CLERK_API_URL: 'https://clerk-api.test' } },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
});
