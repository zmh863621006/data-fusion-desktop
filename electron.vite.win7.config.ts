import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    define: { 'process.env.DATA_FUSION_DEPLOYMENT': JSON.stringify(process.env.DATA_FUSION_DEPLOYMENT ?? 'standard') },
    // The application only uses Cheerio's XML parser. Its slim entry avoids the
    // Node 20 HTTP loader; source field extraction remains on htmlparser2.
    resolve: { alias: [{ find: /^cheerio$/, replacement: resolve('node_modules/cheerio/dist/commonjs/slim.js') }] },
    build: { outDir: process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? 'out-huizhou-win7/main' : 'out-win7/main', target: 'node16', externalizeDeps: false,
      rollupOptions: { input: { index: resolve('src/compat/win7/index.ts') }, output: { entryFileNames: 'index.js' } } },
  },
  preload: { build: { outDir: process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? 'out-huizhou-win7/preload' : 'out-win7/preload', target: 'node16' } },
  renderer: { plugins: [react()], build: { outDir: process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? 'out-huizhou-win7/renderer' : 'out-win7/renderer', target: 'chrome108' } },
});
