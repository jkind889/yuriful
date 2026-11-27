import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Frozen references: what the Fabric renderer gave for a paired test's script, recorded by running
 * that renderer before it was deleted, and stored in `e2e/fabric-reference/` (one JSON file per
 * test, each with its provenance: the commit it was recorded from, the command, the browser and
 * the platform). A test compares the app with its reference exactly as it once compared the app
 * with a live run of the Fabric renderer.
 *
 * A reference is never edited by hand and never recorded from the app: the Fabric renderer is its
 * only source. Its file names the commit whose app source (the Fabric renderer) it was recorded
 * from; the recording harness (`FABRIC_REFERENCE=record`, and `FABRIC_REFERENCE=check`, which
 * compares a live run with the stored reference) exists only in the commit that added these
 * files, the parent of the one that deleted the Fabric renderer. Re-recording means checking that
 * commit out and running the command the file names there. Each carries a
 * hash of the test's inputs (the seeded board and the script), so a test whose script changes
 * fails here instead of comparing with a reference recorded for something else.
 *
 * The hash covers only what the test hands this helper: a changed board, options or declared
 * script. It does not catch every change to how a script is performed (some tests hand it a
 * prose description of what they do, and the shared helpers they call are not hashed), so the
 * code that performs a paired script must not be edited at all.
 * See `docs/engineering-reference.md`.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fabric-reference')

interface RefFile {
  about: string
  test: string
  recordedFrom: Record<string, string>
  entries: Record<string, { inputs: string; value: unknown }>
}

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

function fileFor(file: string, titlePath: readonly string[]): string {
  const spec = path.basename(file).replace(/\.spec\.ts$/, '')
  const title = titlePath.join(' > ')
  const slug = titlePath[titlePath.length - 1]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '')
  const hash = createHash('sha256').update(title).digest('hex').slice(0, 8)
  return path.join(ROOT, spec, `${slug}-${hash}.json`)
}

const used = new Map<string, number>()

/**
 * What the Fabric renderer gave for this test's script, labelled `label` within the test (a
 * second use of the same label in a test reads `label (2)`, and so on). `inputs` is everything
 * the script depends on, and must be what it was when the reference was recorded.
 */
export function fabricReference<T>(label: string, inputs: unknown): T {
  const info = test.info()
  const file = fileFor(info.file, info.titlePath.slice(1))
  const n = (used.get(`${file}#${label}`) ?? 0) + 1
  used.set(`${file}#${label}`, n)
  const key = n === 1 ? label : `${label} (${n})`
  const entry = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RefFile).entries[key] : undefined
  if (!entry) throw new Error(`No frozen Fabric reference "${key}" for this test (${path.relative(process.cwd(), file)}).`)
  const inputsHash = createHash('sha256').update(JSON.stringify(encode(inputs))).digest('hex').slice(0, 16)
  expect(entry.inputs, `the inputs of the frozen Fabric reference "${key}": the script changed since it was recorded`).toBe(inputsHash)
  return decode(entry.value) as T
}
