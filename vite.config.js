import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // React + router — carregam sempre
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Firebase — grande, mas cacheia bem entre páginas
          'vendor-firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          // Recharts — só usado no VendedorDashboard/MetaCard, carrega separado
          'vendor-recharts': ['recharts'],
        },
      },
    },
    // Minificador padrão (esbuild) — terser não está instalado
    minify: 'esbuild',
    // Remove console.* em produção via esbuild
    target: 'es2020',
  },
});
