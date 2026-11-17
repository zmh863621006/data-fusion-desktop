import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'admin-server/web/src/**/*.test.{ts,tsx}'],
    // Native packaging checks use node:test and run via test:packaging.
    exclude: [...configDefaults.exclude, 'scripts/**'],
  },
});
