import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    // Vite dev server — proxy API calls to the daemon's Express server.
    // Production URL is http://localhost:7734 (Express serves everything there).
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:7734',
        changeOrigin: true,
      },
    },
  },
});
