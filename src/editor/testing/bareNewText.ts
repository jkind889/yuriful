/**
 * Vitest setup (vite.config.ts `test.setupFiles`): the unit tests written before paper (Slice 5)
 * create text boxes and check the sizes and places of bare ones, so in every test file a new text box
 * is bare, as it was when they were written (`BARE_NEW_TEXT_KEY` in `src/editor/Editor.ts`, read in
 * development builds only). A test of paper removes the key. The key is spelled out here: importing
 * the editor in a setup file would load Fabric before a test file's own `vi.mock('fabric')`.
 */
// Test files run without a DOM (persistence) have no storage, and make no text boxes.
globalThis.localStorage?.setItem('yuriful:test:bare-new-text', '1')
