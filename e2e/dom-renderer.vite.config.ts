import { mergeConfig } from 'vite'
import type { Plugin } from 'vite'
import base from '../vite.config.ts'

/**
 * The dev server for running the browser suite against the DOM renderer (`E2E_RENDERER=dom`, see
 * `playwright.config.ts`): the app's own config, with the page setting the renderer's test-only
 * switch before the app mounts, as `addInitScript` does in `e2e/interleaving.spec.ts`. Nothing
 * else changes, and nothing uses it unless that variable is set.
 */
const domRenderer: Plugin = {
  name: 'yuriful-e2e-dom-renderer',
  transformIndexHtml: () => [{ tag: 'script', children: "window.__YURIFUL_RENDERER__ = 'dom'", injectTo: 'head-prepend' }],
}

export default mergeConfig(base, { plugins: [domRenderer] })
