import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Caminho base do app. Padrão '/' (dev e deploy full-stack). Para GitHub Pages
  // em projeto, o build usa VITE_BASE='/genus_praxis/' (definido no workflow).
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/patient-photos': 'http://localhost:3001',
    },
  },
})
