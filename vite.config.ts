import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ base: '/wizard-music/', plugins: [react()], build: { outDir: 'dist', emptyOutDir: true } })
