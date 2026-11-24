import { expect } from 'vitest'

/**
 * Frozen references for the unit tests: what the editor on the Fabric renderer gave for a paired
 * test's script (on the fake Fabric, with the same fakes; for `textRules.test.ts`, what the Fabric
 * renderer's typing-shortcut matcher gave), recorded by running it before the Fabric renderer was
 * deleted, and stored with its provenance in `src/editor/testing/fabric-reference/<test file>.json`.
 * The same rules as the browser tests' (`e2e/fabricReference.ts`): never edited by hand, never
 * recorded from the app; recording (`FABRIC_REFERENCE=record`, and `check`) exists only in the
 * commit that added these files. Each carries a hash of the test's inputs (functions by their
 * source), so a changed script fails here instead of comparing with a reference recorded for
 * something else. See `docs/engineering-reference.md`.
 */

interface Fs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
}
interface Crypto {
  createHash(alg: string): { update(s: string): { digest(enc: 'hex'): string } }
}
// Node modules, loaded at run time: the app's TypeScript settings have no Node types.
const node = <T>(name: string): Promise<T> => import(/* @vite-ignore */ `node:${name}`) as Promise<T>

/** JSON keeps neither -0, NaN, the infinities nor undefined: the references store them tagged. */
function encode(value: unknown): unknown {
  if (value === undefined) return { $: 'undefined' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $: 'NaN' }
    if (value === Infinity) return { $: 'Infinity' }
    if (value === -Infinity) return { $: '-Infinity' }
    if (Object.is(value, -0)) return { $: '-0' }
    return value
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
  return value
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    const tag = (value as { $?: unknown }).$
    if (Object.keys(value).length === 1 && typeof tag === 'string') {
      if (tag === 'undefined') return undefined
      if (tag === 'NaN') return NaN
      if (tag === 'Infinity') return Infinity
      if (tag === '-Infinity') return -Infinity
      if (tag === '-0') return -0
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]))
  }
  return value
}

interface RefFile {
  about: string
  recordedFrom: Record<string, string>
  entries: Record<string, { inputs: string; value: unknown }>
}

const used = new Map<string, number>()

/** What the Fabric renderer gave for this test's script, labelled `label` within the test; `inputs` must be what they were when it was recorded. */
export async function fabricReference<T>(label: string, inputs: unknown): Promise<T> {
  const fs = await node<Fs>('fs')
  const { createHash } = await node<Crypto>('crypto')
  const state = expect.getState()
  const testPath = (state.testPath ?? '').replace(/\\/g, '/')
  const file = `${testPath.slice(0, testPath.lastIndexOf('/'))}/testing/fabric-reference/${testPath.slice(testPath.lastIndexOf('/') + 1).replace(/\.test\.ts$/, '')}.json`
  const base = `${state.currentTestName ?? ''} > ${label}`
  const n = (used.get(base) ?? 0) + 1
  used.set(base, n)
  const key = n === 1 ? base : `${base} (${n})`
  const entry = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RefFile).entries[key] : undefined
  if (!entry) throw new Error(`No frozen Fabric reference "${key}" in ${file}.`)
  const hash = createHash('sha256').update(JSON.stringify(encode(inputs), (_, v: unknown) => (typeof v === 'function' ? String(v) : v))).digest('hex').slice(0, 16)
  expect(entry.inputs, `the inputs of the frozen Fabric reference "${key}": the script changed since it was recorded`).toBe(hash)
  return decode(entry.value) as T
}
