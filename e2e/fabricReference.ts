import { expect, test } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Frozen references: what the Fabric renderer gave for a paired test's script, recorded once by
 * running that renderer, and stored in `e2e/fabric-reference/` (one JSON file per test) so that the
 * test keeps an independent reference after the Fabric renderer is deleted.
 *
 * - `FABRIC_REFERENCE=record`: runs the Fabric side of each paired test and writes what it gave.
 * - `FABRIC_REFERENCE=check`: runs the Fabric side, requires it to equal the stored reference
 *   exactly, then compares the DOM renderer with the stored reference (the proof that the frozen
 *   reference is the live one).
 * - unset: reads the stored reference; the Fabric side does not run.
 *
 * Each reference carries a hash of the test's inputs (the seeded board and the script): a test
 * whose script changes no longer matches its reference and fails, rather than comparing with a
 * reference recorded for something else. `FABRIC_REFERENCE_DIR` records into another folder (to
 * compare repeated recordings). A stored reference is never edited by hand and never recorded from
 * the DOM renderer.
 */

const MODE = process.env.FABRIC_REFERENCE as 'record' | 'check' | undefined
const ROOT = process.env.FABRIC_REFERENCE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fabric-reference')

export const ABOUT =
  'A frozen reference: what the Fabric renderer gave for this test, recorded by running it (FABRIC_REFERENCE=record). Never edit it by hand, and never record it from the DOM renderer: the Fabric renderer is its only source. See docs/engineering-reference.md.'

interface Entry {
  inputs: string
  value: unknown
}
interface RefFile {
  about: string
  test: string
  recordedFrom: Record<string, string>
  entries: Record<string, Entry>
}

/** JSON that keeps -0, NaN, the infinities and undefined, which plain JSON loses or changes. */
export function encode(value: unknown): unknown {
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
export function decode(value: unknown): unknown {
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

const hashOf = (inputs: unknown) => createHash('sha256').update(JSON.stringify(encode(inputs))).digest('hex').slice(0, 16)

function fileFor(file: string, titlePath: readonly string[]): string {
  const spec = path.basename(file).replace(/\.spec\.ts$/, '')
  const title = titlePath.join(' > ')
  const slug = titlePath[titlePath.length - 1]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '')
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 8)
  return path.join(ROOT, spec, `${slug}-${hash}.json`)
}

const read = (file: string): RefFile | null => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RefFile) : null)

const used = new Map<string, number>()

/** Where the Fabric renderer that recorded it came from: the commit, and any app source changed from it. */
function provenance(browser: Browser, spec: string): Record<string, string> {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const paths = ['src', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts']
  // Changed content (line endings aside, which a checkout with core.autocrlf rewrites), and new files.
  const changed = [git('diff', '--ignore-cr-at-eol', '--name-status', 'HEAD', '--', ...paths), git('ls-files', '--others', '--exclude-standard', '--', ...paths)]
    .join('\n')
    .split('\n')
    .filter((l) => l && !/\.test\.tsx?$/.test(l) && !/\/testing\//.test(l))
  return {
    commit: git('rev-parse', 'HEAD'),
    appSource: changed.length === 0 ? 'the app source (src/ outside tests, index.html, package files, vite.config.ts) as committed' : `CHANGED FROM THE COMMIT: ${changed.join('; ')}`,
    command: `FABRIC_REFERENCE=record npx playwright test e2e/${spec}`,
    browser: `${browser.browserType().name()} ${browser.version()}`,
    platform: `${process.platform} ${process.arch}`,
    recordedAt: new Date().toISOString().slice(0, 10),
  }
}

/**
 * The Fabric renderer's result for this test's script, labelled `label` within the test: recorded,
 * checked against the stored reference, or (normally) read from it. `inputs` is everything the
 * script depends on (board, steps, options), whose hash must match the stored one.
 */
export async function fabricReference<T>(browser: Browser, label: string, inputs: unknown, live: () => Promise<T>): Promise<T> {
  const info = test.info()
  const file = fileFor(info.file, info.titlePath.slice(1))
  const n = (used.get(`${file}#${label}`) ?? 0) + 1
  used.set(`${file}#${label}`, n)
  const key = n === 1 ? label : `${label} (${n})`
  const inputsHash = hashOf(inputs)
  if (MODE === 'record') {
    const value = await live()
    const spec = path.basename(info.file)
    const ref: RefFile = read(file) ?? { about: ABOUT, test: info.titlePath.slice(1).join(' > '), recordedFrom: provenance(browser, spec), entries: {} }
    ref.recordedFrom = provenance(browser, spec)
    ref.entries[key] = { inputs: inputsHash, value: encode(value) }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(ref, null, 1)}\n`)
    return decode(encode(value)) as T
  }
  const entry = read(file)?.entries[key]
  if (!entry) throw new Error(`No frozen Fabric reference "${key}" for this test (${path.relative(process.cwd(), file)}).`)
  expect(entry.inputs, `the inputs of the frozen Fabric reference "${key}": the script changed since it was recorded`).toBe(inputsHash)
  const frozen = decode(entry.value) as T
  if (MODE === 'check') expect(decode(encode(await live())), `live Fabric renderer against its frozen reference "${key}"`).toEqual(frozen)
  return frozen
}
