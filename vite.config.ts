/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Fabric.js alone is ~half of the bundle; a single chunk is fine for a desktop editor. The
    // editor now also imports ProseMirror and the whole text engine (the DOM scene layer, live
    // editing: ~300 kB minified) while both renderers ship side by side, until the Fabric text
    // path is deleted.
    chunkSizeWarningLimit: 1100,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
