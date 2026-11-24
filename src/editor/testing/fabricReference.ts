import { expect } from 'vitest'

/**
 * Frozen references for the unit tests: what the editor on the Fabric renderer gave for a paired
 * test's script (on the fake Fabric, with the same fakes), recorded once by running it and
 * stored in `src/editor/testing/fabric-reference/<test file>.json`, so that the test keeps an
 * independent reference after the Fabric renderer is deleted. The same modes as the browser
 * tests' `e2e/fabricReference.ts`:
 * - `FABRIC_REFERENCE=record npx vitest run <file>`: runs the Fabric side and writes what it gave;
 * - `FABRIC_REFERENCE=check`: runs it, requires it to equal the stored reference exactly, then
 *   compares the DOM renderer with the stored reference;
 * - unset: reads the stored reference.
 * Each reference carries a hash of the test's inputs, so a changed script fails rather than
 * comparing with a reference recorded for something else. Never edited by hand, never recorded
 * from the DOM renderer.
 */

interface NodeProcess {
  env: Record<string, string | undefined>
  platform: string
  arch: string
  version: string
}
const proc = (globalThis as unknown as { process: NodeProcess }).process
const MODE = proc.env.FABRIC_REFERENCE as 'record' | 'check' | undefined

interface Fs {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string): void
  mkdirSync(p: string, opts: { recursive: true }): void
}
interface ChildProcess {
  execFileSync(cmd: string, args: string[], opts: { encoding: 'utf8' }): string
}
interface Crypto {
  createHash(alg: string): { update(s: string): { digest(enc: 'hex'): string } }
}
// Node modules, loaded at run time: the app's TypeScript settings have no Node types.
const node = <T>(name: string): Promise<T> => import(/* @vite-ignore */ `node:${name}`) as Promise<T>

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

/**
 * The Fabric renderer's result for this test's script, labelled `label` within the test. `inputs`
 * is everything the script depends on (records, steps: functions by their source).
 */
export async function fabricReference<T>(label: string, inputs: unknown, live: () => Promise<T>): Promise<T> {
  const fs = await node<Fs>('fs')
  const { createHash } = await node<Crypto>('crypto')
  const state = expect.getState()
  const testPath = (state.testPath ?? '').replace(/\\/g, '/')
  const dir = `${testPath.slice(0, testPath.lastIndexOf('/'))}/testing/fabric-reference`
  const file = `${dir}/${testPath.slice(testPath.lastIndexOf('/') + 1).replace(/\.test\.ts$/, '')}.json`
  const base = `${state.currentTestName ?? ''} > ${label}`
  const n = (used.get(base) ?? 0) + 1
  used.set(base, n)
  const key = n === 1 ? base : `${base} (${n})`
  const hash = createHash('sha256').update(JSON.stringify(encode(inputs), (_, v: unknown) => (typeof v === 'function' ? String(v) : v))).digest('hex').slice(0, 16)
  const read = (): RefFile | null => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RefFile) : null)
  if (MODE === 'record') {
    const value = await live()
    const { execFileSync } = await node<ChildProcess>('child_process')
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
    const paths = ['src', 'package.json', 'package-lock.json']
    // Changed content (line endings aside, which a checkout with core.autocrlf rewrites), and new files.
    const changed = [git('diff', '--ignore-cr-at-eol', '--name-status', 'HEAD', '--', ...paths), git('ls-files', '--others', '--exclude-standard', '--', ...paths)]
      .join('\n')
      .split('\n')
      .filter((l) => l && !/\.test\.tsx?$/.test(l) && !/\/testing\//.test(l))
    const ref: RefFile = read() ?? { about: '', recordedFrom: {}, entries: {} }
    ref.about =
      'Frozen references: what the editor on the Fabric renderer gave for these tests (fake Fabric and the same fakes), recorded by running it (FABRIC_REFERENCE=record). Never edit them by hand, and never record them from the DOM renderer. See docs/engineering-reference.md.'
    ref.recordedFrom = {
      commit: git('rev-parse', 'HEAD'),
      appSource: changed.length === 0 ? 'the app source (src/ outside tests, package files) as committed' : `CHANGED FROM THE COMMIT: ${changed.join('; ')}`,
      command: 'FABRIC_REFERENCE=record npx vitest run <file>',
      runtime: `Node ${proc.version}, Vitest with jsdom`,
      platform: `${proc.platform} ${proc.arch}`,
      recordedAt: new Date().toISOString().slice(0, 10),
    }
    ref.entries[key] = { inputs: hash, value: encode(value) }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(ref, null, 1)}\n`)
    return decode(encode(value)) as T
  }
  const entry = read()?.entries[key]
  if (!entry) throw new Error(`No frozen Fabric reference "${key}" in ${file}.`)
  expect(entry.inputs, `the inputs of the frozen Fabric reference "${key}": the script changed since it was recorded`).toBe(hash)
  const frozen = decode(entry.value) as T
  if (MODE === 'check') expect(decode(encode(await live())), `live Fabric renderer against its frozen reference "${key}"`).toEqual(frozen)
  return frozen
}
