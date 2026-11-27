import { Textbox } from 'fabric'

type Options = NonNullable<ConstructorParameters<typeof Textbox>[1]>

/** A Text-tool rectangle keeps its drawn height as a floor beneath the text. */
export class DrawnTextbox extends Textbox {
  declare minHeight: number

  constructor(text: string, options: Options, minHeight: number) {
    const drawnOptions = { ...options, minHeight, splitByGrapheme: true }
    super(text, drawnOptions)
  }

  override initDimensions() {
    super.initDimensions()
    this.height = Math.max(this.height, this.minHeight)
  }

  /**
   * Prefer a whitespace break and split an overlong word at a grapheme boundary. Keep
   * every grapheme, including spaces, so Fabric's grapheme-mode style map and cursor
   * navigation can count soft breaks as zero characters. Measure with the actual
   * character styles, like Fabric's _measureLine, including pair kerning on each line.
   */
  override _wrapText(lines: string[], desiredWidth: number): string[][] {
    this.isWrapping = true
    try {
      const spacing = this._getWidthOfCharSpacing()
      let widestGrapheme = 0
      const measured = lines.map((line, li) => {
        const chars = this.graphemeSplit(line)
        const boxes = chars.map((char, ci) => {
          const box = this._getGraphemeBox(char, li, ci, chars[ci - 1], true)
          widestGrapheme = Math.max(widestGrapheme, box.width - spacing)
          return box
        })
        return { chars, boxes }
      })
      // Only one individually oversized grapheme can set a wider minimum.
      this.dynamicMinWidth = widestGrapheme
      const limit = Math.max(desiredWidth, widestGrapheme)
      const wrapped: string[][] = []
      for (const { chars, boxes } of measured) {
        if (chars.length === 0) wrapped.push([])
        let start = 0
        while (start < chars.length) {
          let width = boxes[start]!.width
          let end = start + 1
          let space = this._wordJoiners.test(chars[start]!) ? end : start
          while (end < chars.length && width + boxes[end]!.kernedWidth - spacing <= limit) {
            width += boxes[end]!.kernedWidth
            if (this._wordJoiners.test(chars[end]!)) space = end + 1
            end++
          }
          if (end < chars.length && space > start) end = space
          wrapped.push(chars.slice(start, end))
          start = end
        }
      }
      return wrapped
    } finally {
      this.isWrapping = false
    }
  }
}
