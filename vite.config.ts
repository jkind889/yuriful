/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Fabric.js alone is ~half of the bundle; a single chunk is fine for a desktop editor. The
    // editor also imports ProseMirror and the whole text engine (the scene layer, live editing).
    chunkSizeWarningLimit: 1100,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Tests from before paper make bare text boxes, as when they were written (see the file).
    setupFiles: ['src/editor/testing/bareNewText.ts'],
  },
})
