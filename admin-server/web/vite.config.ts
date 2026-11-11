import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2400,
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
