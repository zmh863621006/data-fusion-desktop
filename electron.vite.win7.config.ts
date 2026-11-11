import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // The application only uses Cheerio's XML parser. Its slim entry avoids the
    // Node 20 HTTP loader; source field extraction remains on htmlparser2.
    resolve: { alias: [{ find: /^cheerio$/, replacement: resolve('node_modules/cheerio/dist/commonjs/slim.js') }] },
    build: { outDir: 'out-win7/main', target: 'node16', externalizeDeps: false,
      rollupOptions: { input: { index: resolve('src/compat/win7/index.ts') }, output: { entryFileNames: 'index.js' } } },
  },
  preload: { build: { outDir: 'out-win7/preload', target: 'node16' } },
  renderer: { plugins: [react()], build: { outDir: 'out-win7/renderer', target: 'chrome108' } },
});
