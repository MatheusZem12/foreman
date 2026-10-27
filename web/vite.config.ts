import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em dev o Vite faz proxy da API para o servidor Go (porta 8700).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5700,
    proxy: { '/api': { target: 'http://localhost:8700', changeOrigin: true } }
  },
  build: { outDir: '../server/internal/webui/dist', emptyOutDir: true, chunkSizeWarningLimit: 900 }
});
