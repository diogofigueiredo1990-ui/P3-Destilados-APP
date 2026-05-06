import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — ~140KB gz, cache por muito tempo
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Firebase — ~100KB gz, cache por muito tempo
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          // Recharts — ~60KB gz, só carrega quando o gráfico é exibido
          'vendor-recharts': ['recharts'],
        },
      },
    },
  },
});
