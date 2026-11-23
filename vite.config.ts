/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Fabric.js alone is ~half of the bundle; a single chunk is fine for a desktop editor. The
    // editor now also imports ProseMirror (the DOM scene layer and the text engine, ~130 kB
    // minified) while both renderers ship side by side, until the Fabric text path is deleted.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
