import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, 'dist-app'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, 'app.html'),
      output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]', chunkFileNames: 'app-[name].js' }
    },
    assetsInlineLimit: 0,
    cssCodeSplit: false
  }
});
