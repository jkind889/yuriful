import { splitGraphemes } from './richText.ts'
import { MAX_BLOCK_DEPTH, isListStart, parseBlocks } from './textDoc.ts'
import type { BlockNode, InlineRun, ListItemNode, TaskItemNode } from './types.ts'

/**
 * Pasted plain Markdown as blocks (plan Section 11, "Markdown conversion of pasted plain text").
 * Pure: no DOM, no ProseMirror. Linear in the length of the text.
 *
 * The markers are the ones the typing shortcuts convert (`src/editor/textRules.ts`):
 * - at the start of a line: `# `, `## `, `### ` (a heading); `- ` (a bullet); `N. ` for N from 1
 *   to `MAX_LIST_START` (a numbered item); `- [ ] `, `- [] `, `- [x] `, `[ ] ` and `[] ` (a
 *   checklist item); `> ` (a quote); a line that is exactly `---` (a divider); a line starting
 *   with three or more backticks opens a code block (the rest of that line, a language, is dropped)
 *   that closes on the next line of only backticks, at least as many as opened it, or runs to the end;
 * - inside a line: `` `code` `` first, left to right (nothing converts inside it), then `**bold**`
 *   and `*italic*`, found as typing the line key by key at its end would find them (`inlineRuns`).
 * Inside a list item, as when typing there, only `[ ] `/`[x] ` (straight after `- `) and the
 * heading markers convert at its start; a heading never stores bold. Nothing converts inside a
 * link or image (`[text](url)`, `![alt](url)`), an HTML tag or comment (each within one line), on
 * a table line (first character other than a space `|`), or for a marker escaped with a backslash.
 *
 * Lines: every line is one block. A blank line is an empty paragraph, except that a single blank
 * line between two items of the same list is dropped; two or more end the list. A list line
 * indented by two columns or more (a tab counts to the next multiple of four) past the item above
 * nests one level deeper, as deep as `MAX_BLOCK_DEPTH` allows; deeper lines stay at the deepest
 * level. Consecutive numbered items are one list, numbered from its first item. Any other indented
 * line under a list item is a further paragraph of that item. Consecutive `> ` lines (and `>` lines
 * among them) are one quote, whose lines are converted again as a paste of their own.
 *
 * Returns null when nothing converts (the paste is the literal paste) and when the result would
 * not be stored (over `MAX_NODES` or `MAX_TEXT_LENGTH`): the caller then pastes literally.
 */
export function markdownToBlocks(text: string): BlockNode[] | null {
  const lines = text.split(/\r\n|\r|\n/)
  const blocks = convertLines(lines, 1)
  if (isLiteral(blocks, lines)) return null
  // The model's own validator is the bound check: it reads exactly what storage would.
  return parseBlocks(blocks) ? blocks : null
}

// ---- characters ---------------------------------------------------------------------------------

/** Characters, besides whitespace, after which an opening `*`, `**` or backtick starts a word (as `textRules.ts`). */
const OPENERS = '([{"\'“‘«'
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)
const STAR = 42
const TICK = 96
const BACKSLASH = 92
/** Context enough, on each side, to see whether two characters join (the longest emoji sequences included). */
const JOIN_REACH = 32

/** True when the UTF-16 unit at `i` is a whole user-perceived character (`ownCharacter` of `textRules.ts`). */
function ownAt(text: string, i: number): boolean {
  // Plain ASCII on both sides never joins (a line holds no "\r\n").
  if (!(text.charCodeAt(i + 1) >= 0x80) && text.charCodeAt(i) < 0x80 && (i === 0 || text.charCodeAt(i - 1) < 0x80)) return true
  if (besideHalf(text, i)) return false
  const from = Math.max(0, i - 2)
  let o = from
  for (const g of splitGraphemes(text.slice(from, i + 3))) {
    if (o === i) return g.length === 1
    if (o > i) return false
    o += g.length
  }
  return false
}

/** For every unit of `s`, whether it is a whole character; null when all are (plain ASCII). */
function ownUnits(s: string): Uint8Array | null {
  let ascii = true
  for (let i = 0; i < s.length && ascii; i++) ascii = s.charCodeAt(i) < 0x80
  if (ascii) return null
  const own = new Uint8Array(s.length)
  let at = 0
  for (const g of splitGraphemes(s)) {
    if (g.length === 1 && !besideHalf(s, at)) own[at] = 1
    at += g.length
  }
  return own
}

const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff
/** Prepend characters (Unicode grapheme rule GB9b): they join the character after them. */
const isPrepend = (cp: number) =>
  (cp >= 0x600 && cp <= 0x605) || cp === 0x6dd || cp === 0x70f || cp === 0x890 || cp === 0x891 || cp === 0x8e2 || cp === 0xd4e || cp === 0x110bd || cp === 0x110cd ||
  cp === 0x111c2 || cp === 0x111c3 || cp === 0x1193f || cp === 0x11941 || cp === 0x11a3a || (cp >= 0x11a84 && cp <= 0x11a89) || cp === 0x11d46 || cp === 0x11f02
const MARK = /^\p{M}/u
const isMark = (cp: number) => cp >= 0x300 && MARK.test(String.fromCodePoint(cp))
/** Characters that join the one before them (rules GB9 and GB9a): marks, ZWNJ and ZWJ, emoji modifiers, tags, halfwidth sound marks. */
const extendsBefore = (cp: number) =>
  isMark(cp) || cp === 0x200c || cp === 0x200d || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f) || cp === 0xff9e || cp === 0xff9f

/** The Hangul jamo class of a code point (rules GB6 to GB8), or 0. */
function hangul(cp: number): 'L' | 'V' | 'T' | 'LV' | 'LVT' | 0 {
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return 'L'
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return 'V'
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return 'T'
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? 'LV' : 'LVT'
  return 0
}

const NEVER = 0
const JOINS = 1
const MAYBE = 2

/**
 * Whether the code points `l` and `r` could join when written next to each other: `NEVER`, `JOINS`
 * (Hangul, decided by its jamo), or `MAYBE` (two regional indicators, whose pairing depends on what
 * comes before, or a joining character, a ZWJ, a mark or a prepend, which the segmenter decides).
 */
function seamKind(l: number, r: number): typeof NEVER | typeof JOINS | typeof MAYBE {
  if (r < 0x300 && l < 0x600) return NEVER
  if (isRegional(l) && isRegional(r)) return MAYBE
  const hl = hangul(l)
  const hr = hangul(r)
  if (hl && hr) return (hl === 'L' && hr !== 'T') || ((hl === 'V' || hl === 'LV') && (hr === 'V' || hr === 'T')) || ((hl === 'T' || hl === 'LVT') && hr === 'T') ? JOINS : NEVER
  return extendsBefore(r) || l === 0x200d || isMark(l) || isPrepend(l) ? MAYBE : NEVER
}

/**
 * True when `left` and `right` written next to each other would join across the seam into one
 * character (a flag from two regional indicators, an emoji joined by a ZWJ or given a skin tone or
 * a variation selector, a letter and a combining mark, Hangul jamo): taking a marker out from
 * between them would then change what is shown, so the marker does not count. Flags and Hangul
 * are decided here; anything else that could join goes to the grapheme segmenter.
 */
function joinsAcross(left: string, right: string): boolean {
  if (left === '' || right === '') return false
  const r = right.codePointAt(0) as number
  const lu = left.charCodeAt(left.length - 1)
  const l = lu >= 0xdc00 && lu <= 0xdfff && left.length > 1 ? (left.codePointAt(left.length - 2) as number) : lu
  const kind = seamKind(l, r)
  if (kind !== MAYBE) return kind === JOINS
  if (isRegional(l) && isRegional(r)) {
    // A flag is a pair: the seam joins when an odd number of regional indicators ends `left`.
    let n = 0
    for (let i = left.length; i >= 2 && isRegional(left.codePointAt(i - 2) as number); i -= 2) n++
    return n % 2 === 1
  }
  let at = 0
  for (const g of splitGraphemes(left + right)) {
    if (at === left.length) return false
    if (at > left.length) return true
    at += g.length
  }
  return true
}

const isAsciiPunctuation = (c: number) => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
const isTagStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 /* / */

/** For every unit of `s` (and its end), the index of the first unit at or after it that is `ch`; -1 for none. */
function nextOf(s: string, ch: number): Int32Array {
  const out = new Int32Array(s.length + 2).fill(-1)
  let n = -1
  for (let i = s.length - 1; i >= 0; i--) {
    if (s.charCodeAt(i) === ch) n = i
    out[i] = n
  }
  return out
}

const isEscape = (s: string, i: number) => s.charCodeAt(i) === BACKSLASH && isAsciiPunctuation(s.charCodeAt(i + 1))

/** For every `[` of `s` that is not escaped, the index of the `]` that closes it (brackets balance; escaped ones do not count); -1 for none. */
function bracketPairs(s: string): Int32Array {
  const out = new Int32Array(s.length).fill(-1)
  const open: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (isEscape(s, i)) i++
    else if (c === 91 /* [ */) open.push(i)
    else if (c === 93 /* ] */ && open.length > 0) out[open.pop() as number] = i
  }
  return out
}

const UNKNOWN = -2

/**
 * For every unit of `s` (and its end), the first `ch` at or after it that no backslash escapes (an
 * even run of backslashes, or none, before it); -1 for none. Inside a title a backslash escapes the
 * next character, and the run of backslashes before a closing quote never reaches past the opening one.
 */
function nextUnescaped(s: string, ch: number): Int32Array {
  const len = s.length
  const escaped = new Uint8Array(len)
  let run = 0
  for (let i = 0; i < len; i++) {
    escaped[i] = run % 2
    run = s.charCodeAt(i) === BACKSLASH ? run + 1 : 0
  }
  const out = new Int32Array(len + 2).fill(-1)
  let n = -1
  for (let i = len - 1; i >= 0; i--) {
    if (s.charCodeAt(i) === ch && !escaped[i]) n = i
    out[i] = n
  }
  return out
}

/**
 * A finder for the `)` that ends a link target whose first unit is `start` (just after its `(`): the
 * target's parentheses balance, a backslash escapes the punctuation after it, and a quoted title
 * (`"…"` or `'…'` after a space or tab, in which a backslash escapes the next character) is skipped
 * whole. -1 when the line ends first.
 *
 * Every call walks the same position-determined path from where it starts, so the answer for every
 * unit a walk passes at its own depth is the walk's answer: each unit is walked once over all calls
 * (memoised), which keeps a line of many `[x](` linear.
 */
function targetCloser(s: string): (start: number) => number {
  const len = s.length
  const memo = new Int32Array(len + 1).fill(UNKNOWN)
  const dq = nextUnescaped(s, 34 /* " */)
  const sq = nextUnescaped(s, 39 /* ' */)
  return (start) => {
    /** The units walked, and where each open parenthesis's own walk starts in it. */
    const walked: number[] = []
    const frames: number[] = [0]
    let r = start
    for (;;) {
      let res: number
      if (r >= len) res = -1
      else if ((memo[r] as number) !== UNKNOWN) res = memo[r] as number
      else {
        walked.push(r)
        const c = s.charCodeAt(r)
        if (isEscape(s, r)) {
          r += 2
          continue
        }
        if (c === 40 /* ( */) {
          frames.push(walked.length)
          r++
          continue
        }
        if ((c === 34 || c === 39) && (s[r - 1] === ' ' || s[r - 1] === '\t')) {
          // The title ends at the next quote of its kind that no backslash escapes.
          const q = (c === 34 ? dq : sq)[r + 1] as number
          r = q >= 0 ? q + 1 : r + 1
          continue
        }
        if (c !== 41 /* ) */) {
          r++
          continue
        }
        res = r
      }
      if (res < 0) {
        for (const v of walked) memo[v] = -1
        return -1
      }
      const from = frames.pop() as number
      for (let k = from; k < walked.length; k++) memo[walked[k] as number] = res
      walked.length = from
      if (frames.length === 0) return res
      r = res + 1
    }
  }
}

/**
 * A finder for the `>` that ends an HTML tag whose name starts at `start` (just after its `<`): the
 * next `>` outside a quoted attribute value (`"…"` or `'…'` after `=`, spaces or tabs allowed
 * between); -1 when a `<` outside quotes or the end of the line comes first. Memoised like
 * `targetCloser`: linear over all calls.
 */
function tagCloser(s: string): (start: number) => number {
  const len = s.length
  const memo = new Int32Array(len + 1).fill(UNKNOWN)
  const dq = nextOf(s, 34)
  const sq = nextOf(s, 39)
  /** Whether the quote at `r` opens a value: an `=` before it, spaces and tabs allowed between (each quote looks back over its own run of them). */
  const afterEquals = (r: number) => {
    let k = r - 1
    while (k >= 0 && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k--
    return s.charCodeAt(k) === 61 /* = */
  }
  return (start) => {
    const walked: number[] = []
    let r = start
    let res: number
    for (;;) {
      if (r >= len) {
        res = -1
        break
      }
      if ((memo[r] as number) !== UNKNOWN) {
        res = memo[r] as number
        break
      }
      walked.push(r)
      const c = s.charCodeAt(r)
      if (c === 62 /* > */) {
        res = r
        break
      }
      if (c === 60 /* < */) {
        res = -1
        break
      }
      if ((c === 34 || c === 39) && afterEquals(r)) {
        const q = (c === 34 ? dq : sq)[r + 1] as number
        if (q < 0) {
          res = -1
          break
        }
        r = q + 1
        continue
      }
      r++
    }
    for (const v of walked) memo[v] = res
    return res
  }
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff
/** Whether the unit at `j` is half of a surrogate pair without its other half. */
function unpairedAt(s: string, j: number): boolean {
  const c = s.charCodeAt(j)
  if (isHighSurrogate(c)) return !isLowSurrogate(s.charCodeAt(j + 1))
  if (isLowSurrogate(c)) return !isHighSurrogate(s.charCodeAt(j - 1))
  return false
}
/**
 * A unit beside an unpaired surrogate half, on either side: taking it out could put the two halves
 * of one character on either side of a formatting boundary, so it is never a marker.
 */
const besideHalf = (s: string, i: number) => unpairedAt(s, i - 1) || unpairedAt(s, i + 1)

// ---- inline marks -------------------------------------------------------------------------------

const BOLD = 1
const ITALIC = 2
const CODE = 4

function runOf(text: string, key: number): InlineRun {
  const run: InlineRun = { text }
  if (key & BOLD) run.bold = true
  if (key & ITALIC) run.italic = true
  if (key & CODE) run.code = true
  return run
}

/**
 * The runs of `line` from `from`, in two passes.
 *
 * 1. Left to right, within this line only, what is kept as written; the earliest construct that
 *    completes wins, and an opener that completes nothing is a character (the scan goes on just
 *    after it):
 *    - a backslash and the ASCII punctuation it escapes;
 *    - a code span: a backtick that starts a word, closed by the next backtick, with code between
 *      them that is not empty and has no whitespace just inside either backtick (the typed rule);
 *      the backticks go, the code is marked and nothing in it is a marker;
 *    - a link or image `[label](target)` / `![label](target)`: the label's brackets balance
 *      (escaped ones do not count), `(` follows its `]`, and the target runs to its own `)`
 *      (parentheses balance, a backslash escapes, a quoted title after a space is skipped whole);
 *    - an HTML tag: `<` and a letter or `/`, to the next `>` outside a quoted attribute value, with
 *      no other `<` before it; a comment `<!--` to the next `-->`; `<!…>` and `<?…>` to the next `>`.
 *    Nothing that continues on the next line is recognised (a known limit).
 * 2. The rest typed key by key (a grapheme cluster at a time) at the line's end, with
 *    `matchShortcut`'s rule after each `*`: the closing marker pairs with the nearest live marker
 *    before it, the marked text is not empty, has no whitespace just inside either marker, the
 *    opener starts a word, no marker character is joined to a mark, and a marker removed by an
 *    earlier conversion is gone. Characters typed after a conversion never carry its mark, so only
 *    the marked text of a conversion gets a mark; conversions can nest. In a heading, bold markers
 *    go but bold is not stored.
 * In both passes a marker does not count when taking it out would join the characters on either
 * side of it into one (`joinsAcross`).
 *
 * Linear: code spans and declarations are found through next-occurrence tables, labels through
 * one bracket-pairing pass, targets and tags through memoised walks (`targetCloser`), live characters
 * are a linked list, live `*`s are a stack (a conversion only ever removes the top ones), and marks
 * are recorded as ranges and swept once at the end.
 */
function inlineRuns(line: string, from: number, heading: boolean): InlineRun[] {
  if (from >= line.length) return []
  const s = from === 0 ? line : line.slice(from)
  if (!s.includes('*') && !s.includes('`')) return [{ text: s }]
  const len = s.length
  const own = ownUnits(s)
  const isOwn = (u: number) => own === null || own[u] === 1
  /** 1: kept as written, never a marker. */
  const kept = new Uint8Array(len)
  const gone = new Uint8Array(len)
  const bold = new Int32Array(len + 1)
  const italic = new Int32Array(len + 1)
  const code = new Int32Array(len + 1)
  const add = (range: Int32Array, a: number, b: number) => {
    range[a] = (range[a] as number) + 1
    range[b] = (range[b] as number) - 1
  }
  const keep = (a: number, b: number) => kept.fill(1, a, b)
  const startsWord = (c: string | undefined) => c === undefined || isSpace(c) || OPENERS.includes(c)

  /** The code point ending at unit `u` (a low surrogate with the high one before it), or starting at it. */
  const cpEnding = (u: number) => {
    const c = s.charCodeAt(u)
    return c >= 0xdc00 && c <= 0xdfff && u > 0 ? (s.codePointAt(u - 1) as number) : c
  }
  /** Whether the units `l` and `r` could join across a seam (`seamKind` is not `NEVER`). */
  const mayJoin = (l: number, r: number) => l >= 0 && r >= 0 && seamKind(cpEnding(l), s.codePointAt(r) as number) !== NEVER

  // Pass 1: escapes, code spans, links, images, tags and comments, left to right; the earliest that completes wins.
  const nextTick = nextOf(s, TICK)
  const nextAngle = nextOf(s, 62 /* > */)
  const brackets = bracketPairs(s)
  const targetEnd = targetCloser(s)
  const tagEnd = tagCloser(s)
  let comments = true // false once no `-->` is left on the line
  for (let i = 0; i < len; ) {
    const c = s.charCodeAt(i)
    if (isEscape(s, i)) {
      keep(i, i + 2)
      i += 2
      continue
    }
    if (c === TICK) {
      const j = nextTick[i + 1] as number
      const ok = j > i + 1 && startsWord(s[i - 1]) && !isSpace(s[i + 1]) && !isSpace(s[j - 1]) && isOwn(i) && isOwn(j)
      const seams = () =>
        !(mayJoin(i - 1, i + 1) && joinsAcross(s.slice(Math.max(0, i - JOIN_REACH), i), s.slice(i + 1, Math.min(j, i + 1 + JOIN_REACH)))) &&
        !(mayJoin(j - 1, j + 1 < len ? j + 1 : -1) && joinsAcross(s.slice(Math.max(i + 1, j - JOIN_REACH), j), s.slice(j + 1, j + 1 + JOIN_REACH)))
      if (ok && seams()) {
        gone[i] = 1
        gone[j] = 1
        keep(i + 1, j)
        add(code, i + 1, j)
        i = j + 1
      } else i++
      continue
    }
    let end = -1
    const label = c === 91 /* [ */ ? i : c === 33 /* ! */ && s.charCodeAt(i + 1) === 91 ? i + 1 : -1
    if (label >= 0) {
      // `[label](target)`: the label's own `]`, straight after it `(`, then the target's own `)`.
      const close = brackets[label] as number
      if (close >= 0 && s.charCodeAt(close + 1) === 40 /* ( */) end = targetEnd(close + 2)
    } else if (c === 60 /* < */) {
      const n = s.charCodeAt(i + 1)
      if (s.startsWith('<!--', i)) {
        const k = comments ? s.indexOf('-->', i + 4) : -1
        if (k < 0) comments = false
        else end = k + 2
      } else if (n === 33 /* ! */ || n === 63 /* ? */) end = nextAngle[i + 2] as number
      else if (isTagStart(n)) end = tagEnd(i + 1)
    }
    if (end >= 0) {
      keep(i, end + 1)
      i = end + 1
    } else i++ // an opener that completes nothing is a character
  }
  // Pass 2: `*` and `**`, as typed.
  const prev = new Int32Array(len)
  const next = new Int32Array(len)
  const stars: number[] = []
  let last = -1
  const prevOf = (u: number) => prev[u] as number
  const nextOfLive = (u: number) => next[u] as number
  const remove = (u: number) => {
    gone[u] = 1
    const p = prevOf(u)
    const q = nextOfLive(u)
    if (p >= 0) next[p] = q
    if (q >= 0) prev[q] = p
    if (u === last) last = p
  }
  /** The live text ending at `u` (inclusive), as far as joining can reach. */
  const liveBefore = (u: number) => {
    let out = ''
    for (let v = u; v >= 0 && out.length < JOIN_REACH; v = prevOf(v)) out = s[v] + out
    return out
  }
  /** The live text from `u` on, as far as joining can reach. */
  const liveFrom = (u: number) => {
    let out = ''
    for (let v = u; v >= 0 && out.length < JOIN_REACH; v = nextOfLive(v)) out += s[v]
    return out
  }
  /** The first unit still to be typed after `u` (the backticks of code spans are gone already); -1 at the end. */
  const firstAhead = (u: number) => {
    let v = u + 1
    while (v < len && gone[v]) v++
    return v < len ? v : -1
  }
  /** The text still to be typed after `u`, without the backticks of code spans. */
  const ahead = (u: number) => {
    let out = ''
    for (let v = u + 1; v < len && out.length < JOIN_REACH; v++) if (!gone[v]) out += s[v]
    return out
  }

  const star = (u: number) => {
    const p1 = prevOf(u)
    const n = p1 >= 0 && s.charCodeAt(p1) === STAR && !kept[p1] ? 2 : 1
    const close = n === 2 ? p1 : u
    const k = stars.length - 1 - n
    if (k < 0) return
    const j = stars[k] as number
    const start = nextOfLive(j)
    if (start === close || isSpace(s[start]) || isSpace(s[prevOf(close)])) return
    let open = j
    if (n === 2) {
      open = prevOf(j)
      if (open < 0 || s.charCodeAt(open) !== STAR || kept[open]) return
    }
    const before = prevOf(open)
    if (!startsWord(before >= 0 ? s[before] : undefined)) return
    if (!isOwn(open) || !isOwn(j) || !isOwn(close)) return
    if (before >= 0 && mayJoin(before, start) && joinsAcross(liveBefore(before), liveFrom(start))) return
    const end = prevOf(close)
    if (mayJoin(end, firstAhead(u)) && joinsAcross(liveBefore(end), ahead(u))) return
    add(n === 2 ? bold : italic, start, close)
    remove(u)
    if (n === 2) remove(close)
    remove(j)
    if (n === 2) remove(open)
    stars.length = n === 2 ? k - 1 : k
  }

  for (let u = 0; u < len; u++) {
    if (gone[u]) continue
    prev[u] = last
    next[u] = -1
    if (last >= 0) next[last] = u
    last = u
    if (s.charCodeAt(u) === STAR && !kept[u]) {
      stars.push(u)
      if (isOwn(u)) star(u)
    }
  }

  const runs: InlineRun[] = []
  let b = 0
  let it = 0
  let cd = 0
  let key = -1
  let text = ''
  let pieceFrom = -1
  const flushPiece = (to: number) => {
    if (pieceFrom >= 0) text += s.slice(pieceFrom, to)
    pieceFrom = -1
  }
  for (let u = 0; u < len; u++) {
    b += bold[u] as number
    it += italic[u] as number
    cd += code[u] as number
    if (gone[u]) {
      flushPiece(u)
      continue
    }
    const k = (b > 0 && !heading ? BOLD : 0) | (it > 0 ? ITALIC : 0) | (cd > 0 ? CODE : 0)
    if (k !== key) {
      flushPiece(u)
      if (text) runs.push(runOf(text, key))
      text = ''
      key = k
    }
    if (pieceFrom < 0) pieceFrom = u
  }
  flushPiece(len)
  if (text) runs.push(runOf(text, key))
  return runs
}

// ---- one line -----------------------------------------------------------------------------------

const paragraphOf = (text: string): BlockNode => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })

/**
 * A paragraph or heading holding `line` from `from`. Heading markers at its start convert as typing
 * them would, each one replacing the level of the last (`# ## x` is a level-2 heading `x`).
 */
function leafOf(line: string, from: number): BlockNode {
  let level = 0
  let p = from
  for (;;) {
    let k = 0
    while (k < 4 && line.charCodeAt(p + k) === 35 /* # */) k++
    if (k < 1 || k > 3 || line[p + k] !== ' ' || !ownAt(line, p + k)) break
    level = k
    p += k + 1
  }
  const content = inlineRuns(line, p, level > 0)
  const withContent = content.length > 0 ? { content } : {}
  return level === 1 || level === 2 || level === 3 ? { type: 'heading', level, ...withContent } : { type: 'paragraph', ...withContent }
}

type ListKind = 'bulletList' | 'orderedList' | 'taskList'

interface ListLine {
  /** Columns of leading whitespace (a tab reaches the next multiple of four). */
  indent: number
  kind: ListKind
  start: number
  checked: boolean
  /** Where the item's own text starts. */
  rest: number
}

function indentOf(line: string): { width: number; end: number } {
  let width = 0
  let end = 0
  for (; end < line.length; end++) {
    const c = line.charCodeAt(end)
    if (c === 32) width++
    else if (c === 9) width += 4 - (width % 4)
    else break
  }
  return { width, end }
}

/** A checkbox `[ ] `, `[] ` or `[x] ` at `at`: its length and whether it is ticked. */
function checkboxAt(line: string, at: number): { length: number; checked: boolean } | null {
  for (const [box, checked] of [['[ ] ', false], ['[] ', false], ['[x] ', true]] as const) {
    if (line.startsWith(box, at) && ownAt(line, at + box.length - 1)) return { length: box.length, checked }
  }
  return null
}

/** The list marker that starts `line` after its indent, or null. */
function listLineOf(line: string): ListLine | null {
  const { width, end } = indentOf(line)
  const item = (kind: ListKind, rest: number, start = 1, checked = false): ListLine => ({ indent: width, kind, start, checked, rest })
  if (line.startsWith('- ', end) && ownAt(line, end + 1)) {
    // A bullet whose item starts with a checkbox becomes a checklist item, as typed.
    const box = checkboxAt(line, end + 2)
    return box ? item('taskList', end + 2 + box.length, 1, box.checked) : item('bulletList', end + 2)
  }
  // A ticked box alone is no marker: typed, `[x] ` converts only straight after `- `.
  const box = checkboxAt(line, end)
  if (box && !box.checked) return item('taskList', end + box.length)
  let d = end
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++
  if (d > end && line[d] === '.' && line[d + 1] === ' ' && ownAt(line, d + 1)) {
    const start = Number(line.slice(end, d))
    if (isListStart(start)) return item('orderedList', d + 2, start)
  }
  return null
}

/** The number of backticks (three or more) that open a code block on `line`; 0 when it opens none. */
function fenceOpen(line: string): number {
  let n = 0
  while (line.charCodeAt(n) === TICK) n++
  return n >= 3 && ownAt(line, n - 1) ? n : 0
}

/** True when `line` closes a code block opened by `n` backticks: only backticks, at least `n`, then spaces or tabs. */
function closesFence(line: string, n: number): boolean {
  let k = 0
  while (line.charCodeAt(k) === TICK) k++
  if (k < n) return false
  for (; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return false
  return true
}

const isQuoteLine = (line: string) => line.startsWith('> ') && ownAt(line, 1)
const isBlank = (line: string) => /^[ \t]*$/.test(line)
const isTableLine = (line: string) => line[indentOf(line).end] === '|'

/** True when the blocks are the lines as plain paragraphs: nothing converted. */
function isLiteral(blocks: readonly BlockNode[], lines: readonly string[]): boolean {
  if (blocks.length !== lines.length) return false
  return blocks.every((b, i) => {
    if (b.type !== 'paragraph') return false
    const runs = b.content ?? []
    if (runs.length === 0) return lines[i] === ''
    const run = runs[0] as InlineRun
    return runs.length === 1 && Object.keys(run).length === 1 && run.text === lines[i]
  })
}

// ---- lines into blocks ----------------------------------------------------------------------------

type ListNode = Extract<BlockNode, { type: ListKind }>

interface Level {
  /** The indent of this level's last item: later lines are measured against it. */
  indent: number
  list: ListNode
  item: ListItemNode | TaskItemNode
  /** The blocks the list is the last of. */
  container: BlockNode[]
}

function newItem(m: ListLine, leaf: BlockNode): ListItemNode | TaskItemNode {
  return m.kind === 'taskList' ? { checked: m.checked, blocks: [leaf] } : { blocks: [leaf] }
}

function newList(m: ListLine, item: ListItemNode | TaskItemNode): ListNode {
  if (m.kind === 'taskList') return { type: 'taskList', items: [item as TaskItemNode] }
  if (m.kind === 'orderedList') return { type: 'orderedList', ...(m.start > 1 && { start: m.start }), items: [item] }
  return { type: 'bulletList', items: [item] }
}

/** The blocks of `lines`, at `depth` (top level is 1, as `parseBlocks` counts). */
function convertLines(lines: readonly string[], depth: number): BlockNode[] {
  const out: BlockNode[] = []
  let stack: Level[] = []
  /** Blank lines met while a list is open, not yet placed. */
  let blanks: string[] = []
  /** Lines before this index are known to start no quote. */
  let noQuoteBefore = 0
  const canList = depth < MAX_BLOCK_DEPTH

  /** Ends the open list; the waiting blank lines become paragraphs after it, as they were. */
  const settle = () => {
    stack = []
    for (const b of blanks) out.push(paragraphOf(b))
    blanks = []
  }

  const openList = (m: ListLine, line: string, container: BlockNode[]): Level => {
    const item = newItem(m, leafOf(line, m.rest))
    const list = newList(m, item)
    container.push(list)
    return { indent: m.indent, list, item, container }
  }

  const placeItem = (m: ListLine, line: string) => {
    if (stack.length === 0) {
      stack.push(openList(m, line, out))
      return
    }
    let at = stack.length - 1
    while (at > 0 && (stack[at] as Level).indent > m.indent) at--
    let nest = false
    if (m.indent >= (stack[at] as Level).indent + 2) {
      if (at < stack.length - 1) at++ // between two levels: beside the deeper one
      else if (depth + stack.length + 1 <= MAX_BLOCK_DEPTH) nest = true
    }
    const level = stack[at] as Level
    // Items of one kind at one level are one list (a numbered one keeps its first number).
    const joins = !nest && level.list.type === m.kind
    if (blanks.length > 0) {
      if (blanks.length > 1 || (!joins && !nest && at === 0)) {
        // Two blank lines end the list; so does one before a list of another kind at the top.
        settle()
        stack.push(openList(m, line, out))
        return
      }
      blanks = []
      // One blank line between two items of the same list is dropped; before another list inside an item it stays there.
      if (!joins) (nest ? level.item.blocks : level.container).push({ type: 'paragraph' })
    }
    stack.length = at + 1
    if (nest) stack.push(openList(m, line, level.item.blocks))
    else if (joins) {
      const item = newItem(m, leafOf(line, m.rest))
      ;(level.list.items as Array<ListItemNode | TaskItemNode>).push(item)
      level.item = item
      level.indent = m.indent
    } else {
      const fresh = openList(m, line, level.container)
      level.list = fresh.list
      level.item = fresh.item
      level.indent = m.indent
    }
  }

  /**
   * An indented line under a list item: a further paragraph of the item it is indented under (a
   * table line exactly as written). False when it is under none, or after two blank lines.
   */
  const continueItem = (line: string, table: boolean): boolean => {
    if (blanks.length > 1) return false
    const { width, end } = indentOf(line)
    let at = stack.length - 1
    while (at >= 0 && (stack[at] as Level).indent >= width) at--
    if (at < 0) return false
    const level = stack[at] as Level
    if (blanks.length > 0) level.item.blocks.push({ type: 'paragraph' })
    blanks = []
    level.item.blocks.push(table ? paragraphOf(line.slice(end)) : leafOf(line, end))
    stack.length = at + 1
    return true
  }

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string
    const fence = fenceOpen(line)
    if (fence > 0) {
      settle()
      let j = i + 1
      while (j < lines.length && !closesFence(lines[j] as string, fence)) j++
      out.push({ type: 'codeBlock', text: lines.slice(i + 1, j).join('\n') })
      i = j < lines.length ? j + 1 : j
      continue
    }
    if (i >= noQuoteBefore && depth < MAX_BLOCK_DEPTH && (line === '>' || isQuoteLine(line))) {
      let j = i
      let quoted = false
      for (; j < lines.length; j++) {
        const l = lines[j] as string
        if (isQuoteLine(l)) quoted = true
        else if (l !== '>') break
      }
      if (quoted) {
        settle()
        const inner = lines.slice(i, j).map((l) => (l === '>' ? '' : l.slice(2)))
        out.push({ type: 'blockquote', blocks: convertLines(inner, depth + 1) })
        i = j
        continue
      }
      noQuoteBefore = j // a run of `>` lines alone stays literal
    }
    if (isBlank(line)) {
      if (stack.length > 0) blanks.push(line)
      else out.push(paragraphOf(line))
      i++
      continue
    }
    const c = line.charCodeAt(0)
    const indented = c === 32 || c === 9
    if (isTableLine(line)) {
      // A table stays as written, cell by cell: under a list item when indented under one, else after any list.
      if (stack.length > 0 && indented && continueItem(line, true)) {
        i++
        continue
      }
      settle()
      out.push(paragraphOf(line))
      i++
      continue
    }
    const m = canList ? listLineOf(line) : null
    if (m) {
      placeItem(m, line)
      i++
      continue
    }
    if (stack.length > 0 && indented && continueItem(line, false)) {
      i++
      continue
    }
    settle()
    out.push(line === '---' ? { type: 'divider' } : leafOf(line, 0))
    i++
  }
  settle()
  return out
}
