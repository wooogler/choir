import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/docs-app/',
  build: {
    outDir: '../public/docs-app',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3030',
    },
  },
});
