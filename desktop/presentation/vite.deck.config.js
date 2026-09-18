import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, 'dist-deck'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(__dirname, 'deck.html'),
      output: { entryFileNames: 'deck.js', assetFileNames: 'deck.[ext]' }
    },
    assetsInlineLimit: 100000000,
    cssCodeSplit: false
  }
});
