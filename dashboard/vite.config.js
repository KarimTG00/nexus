import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // L'API tourne sur le service web (workers/api.js). Le proxy évite le CORS
    // en développement et permet d'utiliser les mêmes chemins qu'en production.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } }
  },
  build: { outDir: 'dist' }
})
