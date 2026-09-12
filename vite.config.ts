import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
  worker: { format: 'es' },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
