import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the UI runs on 5173 and proxies API calls to the Express server on 4000.
// Production: `npm run build` writes web/dist, which Express serves.
const API = process.env.LOANLENS_API || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': API, '/mock': API } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.js'], include: ['test/**/*.test.{js,jsx}'] },
});
