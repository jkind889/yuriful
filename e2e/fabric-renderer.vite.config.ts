import { mergeConfig } from 'vite'
import type { Plugin } from 'vite'
import base from '../vite.config.ts'

/**
 * The dev server for running the browser suite against the Fabric renderer (`E2E_RENDERER=fabric`,
 * see `playwright.config.ts`): the app's own config, with the page setting the renderer's
 * test-only switch before the app mounts. A page that chose a renderer itself (the paired tests'
 * `addInitScript`, which runs first) keeps its choice. Nothing else changes, and nothing uses it
 * unless that variable is set.
 */
const fabricRenderer: Plugin = {
  name: 'yuriful-e2e-fabric-renderer',
  transformIndexHtml: () => [{ tag: 'script', children: "window.__YURIFUL_RENDERER__ ??= 'fabric'", injectTo: 'head-prepend' }],
}

export default mergeConfig(base, { plugins: [fabricRenderer] })
