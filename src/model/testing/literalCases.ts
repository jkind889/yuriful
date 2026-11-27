/**
 * Text that stays exactly as written, whether it is typed key by key (the typing shortcuts of
 * `src/editor/textRules.ts`) or pasted as plain text (`markdownToBlocks`): one table, so that the
 * two rule sets cannot drift apart (plan Section 11, test
 * `markdown-paste-shares-the-typed-literal-cases`). A row may hold several lines ("\n").
 */
export interface LiteralCase {
  text: string
  /** Why nothing in it converts. */
  why: string
}

export const LITERAL_CASES: readonly LiteralCase[] = [
  // The pinned typed cases (plan Section 8).
  { text: '2 * 3 * 4', why: 'each `*` has a space just inside it' },
  { text: 'a ** b', why: 'a `**` with nothing marked after it' },
  { text: '* item', why: '`* ` is no bullet (owner decision 7)' },
  { text: '**', why: 'markers with nothing between them' },
  { text: 'snake*case*', why: 'the opening `*` is inside a word' },
  { text: '***x***', why: 'every marker touches another `*`' },
  { text: '#tag', why: 'no space after the `#`' },
  { text: '#tag ', why: 'a space after a word that starts with `#`' },
  { text: '#### four', why: 'four `#` is not a heading level' },
  { text: '#### ', why: 'four `#` is not a heading level, even with nothing after it' },
  { text: 'a # b', why: 'a `#` after text' },
  { text: 'a # ', why: 'a `#` after text, with nothing after it' },
  { text: '** x**', why: 'a space just inside the opening marker' },
  { text: '*x *', why: 'a space just inside the closing marker' },
  { text: '#x', why: 'no space after the `#`' },
  // Markdown that has no shortcut.
  { text: '[text](https://example.com)', why: 'links have no shortcut' },
  { text: '![alt](https://example.com/a.png)', why: 'images have no shortcut' },
  { text: '| a | b |\n|---|---|\n| 1 | 2 |', why: 'tables have no shortcut' },
  { text: '<b>raw</b> <em>html</em>', why: 'HTML is text' },
  { text: '_underscore_ and __double__', why: 'only `*` marks emphasis' },
  { text: '~~strike~~', why: 'strikethrough has no shortcut' },
  { text: '+ item', why: '`+ ` is no bullet' },
  { text: '* [ ] task', why: 'a checkbox only after `- `' },
  { text: '\\*not italic\\* and \\# not a heading', why: 'a backslash is text: the opener is not at a word start' },
  { text: '\\- not a bullet', why: 'a backslash is text before the `-`' },
  { text: 'Title\n=====', why: 'a heading underlined with `=` has no shortcut' },
  { text: '-no space', why: 'a bullet needs a space after `-`' },
  { text: '1.no space', why: 'a numbered item needs a space after the dot' },
  { text: '0. zero', why: 'a list starts at 1 or more' },
  { text: '1000000000. too big', why: 'a list starts at 999,999,999 at most' },
  { text: '>no space', why: 'a quote needs a space after `>`' },
  { text: 'x`y` and ``', why: 'the opening backtick is inside a word; two backticks mark nothing' },
  { text: '[x] ticked', why: 'a ticked box converts only straight after `- `' },
  { text: '  # indented', why: 'a heading marker starts the line' },
]
