import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { define: { 'process.env.DATA_FUSION_DEPLOYMENT': JSON.stringify(process.env.DATA_FUSION_DEPLOYMENT ?? 'standard') },
    ...(process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? { build: { outDir: 'out-huizhou/main' } } : {}) },
  preload: { ...(process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? { build: { outDir: 'out-huizhou/preload' } } : {}) },
  renderer: {
    plugins: [react()],
    ...(process.env.DATA_FUSION_DEPLOYMENT === 'huizhou-intranet' ? { build: { outDir: 'out-huizhou/renderer' } } : {}),
  },
});
