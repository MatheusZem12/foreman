import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite proxies the API to the Go server (port 8700).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5700,
    proxy: { '/api': { target: 'http://localhost:8700', changeOrigin: true } }
  },
  build: {
    outDir: '../server/internal/webui/dist',
    emptyOutDir: true,
    target: 'es2020',
    // Libraries change far less often than the app: in their own files they stay in the
    // browser cache across deploys, and each screen downloads only what it uses.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          markdown: ['marked', 'dompurify']
        }
      }
    }
  }
});
