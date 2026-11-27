import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredAsset } from '../model/types.ts'
import { AssetCache } from './assets.ts'

/**
 * The asset cache with the browser parts (blob URLs, image decoding) stubbed: jsdom decodes no
 * images. Only the bookkeeping of URLs and entries is tested here.
 */
const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([1]).buffer })

let created: string[]
let revoked: string[]
let decodes: Array<{ resolve: () => void }>

beforeEach(() => {
  created = []
  revoked = []
  decodes = []
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test-${++n}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url)
  })
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = 10
      naturalHeight = 20
      decode() {
        return new Promise<void>((resolve) => decodes.push({ resolve }))
      }
    },
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AssetCache', () => {
  it('keeps a decoded image and its bytes, and revokes its URL on dispose', async () => {
    const cache = new AssetCache()
    const loading = cache.load(asset('a'))
    decodes[0]!.resolve()
    const el = await loading
    expect(cache.get('a')).toBe(el)
    expect(cache.bytes('a')?.id).toBe('a')
    cache.dispose()
    expect(revoked).toEqual(created)
  })

  it('a decode that finishes after dispose revokes its URL and caches nothing', async () => {
    const cache = new AssetCache()
    const loading = cache.load(asset('late'))
    cache.dispose()
    decodes[0]!.resolve()
    await expect(loading).rejects.toThrow(/disposed/)
    expect(cache.get('late')).toBeUndefined()
    expect(revoked).toEqual(created) // every URL ever made has been revoked
    await expect(cache.load(asset('after'))).rejects.toThrow(/disposed/)
    expect(created).toHaveLength(1) // no URL is made after dispose
  })
})
