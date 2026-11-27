import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const SelectIcon = () => (
  <Svg>
    <path d="M5 3.5l13 6.2-5.6 1.7-1.9 5.8L5 3.5z" />
  </Svg>
)
export const HandIcon = () => (
  <Svg>
    <path d="M8 12V6.5a1.5 1.5 0 013 0V11m0-5.5v-1a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.5a5.5 5.5 0 01-4.4-2.2L4.2 14.6a1.5 1.5 0 012.3-1.9L8 14" />
  </Svg>
)
export const ImageIcon = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4" />
  </Svg>
)
export const TextIcon = () => (
  <Svg>
    <path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5" />
  </Svg>
)
export const FrameIcon = () => (
  <Svg>
    <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
  </Svg>
)
export const SelectContentsIcon = () => (
  <Svg>
    <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
    <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
  </Svg>
)
export const UndoIcon = () => (
  <Svg>
    <path d="M9 7L4.5 11.5 9 16M5 11.5h9a5.5 5.5 0 010 11" transform="translate(0 -3)" />
  </Svg>
)
export const RedoIcon = () => (
  <Svg>
    <path d="M15 7l4.5 4.5L15 16M19 11.5h-9a5.5 5.5 0 000 11" transform="translate(0 -3)" />
  </Svg>
)
export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const MinusIcon = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
)
export const FitIcon = () => (
  <Svg>
    <path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15" />
  </Svg>
)
export const TrashIcon = () => (
  <Svg>
    <path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l.8 12a1.5 1.5 0 001.5 1.4h6.4a1.5 1.5 0 001.5-1.4l.8-12M10 11v6M14 11v6" />
  </Svg>
)
export const ToFrontIcon = () => (
  <Svg>
    <rect x="9" y="9" width="10" height="10" rx="2" />
    <path d="M5 15V6.5A1.5 1.5 0 016.5 5H15" />
    <path d="M4 4h7" />
  </Svg>
)
export const ForwardIcon = () => (
  <Svg>
    <rect x="9" y="9" width="10" height="10" rx="2" />
    <path d="M5 15V6.5A1.5 1.5 0 016.5 5H15" />
  </Svg>
)
export const BackwardIcon = () => (
  <Svg>
    <rect x="5" y="5" width="10" height="10" rx="2" />
    <path d="M19 9v8.5a1.5 1.5 0 01-1.5 1.5H9" />
  </Svg>
)
export const ToBackIcon = () => (
  <Svg>
    <rect x="5" y="5" width="10" height="10" rx="2" />
    <path d="M19 9v8.5a1.5 1.5 0 01-1.5 1.5H9" />
    <path d="M13 20h7" />
  </Svg>
)
export const ChevronIcon = () => (
  <Svg>
    <path d="M7 10l5 5 5-5" />
  </Svg>
)

export const BoldIcon = () => (
  <Svg>
    <path d="M7.5 5h5.25a3.25 3.25 0 010 6.5H7.5zM7.5 11.5h6a3.5 3.5 0 010 7h-6z" strokeWidth="2.4" />
  </Svg>
)
export const ItalicIcon = () => (
  <Svg>
    <path d="M10.5 5H17M7 19h6.5M14 5l-4 14" />
  </Svg>
)
export const UnderlineIcon = () => (
  <Svg>
    <path d="M7.5 4.5v6.5a4.5 4.5 0 009 0V4.5M6 20h12" />
  </Svg>
)
export const StrikeIcon = () => (
  <Svg>
    <path d="M16.5 7.2A4.2 3.2 0 0012 5c-2.5 0-4.3 1.3-4.3 3.1 0 1.2.8 2.1 2.4 2.7M8 16.7c.9 1.4 2.4 2.3 4.4 2.3 2.6 0 4.4-1.4 4.4-3.3 0-.9-.4-1.7-1.2-2.3M4.5 12h15" />
  </Svg>
)
export const AlignLeftIcon = () => (
  <Svg>
    <path d="M4.5 6.5h15M4.5 10.5h9.5M4.5 14.5h15M4.5 18.5h9.5" />
  </Svg>
)
export const AlignCenterIcon = () => (
  <Svg>
    <path d="M4.5 6.5h15M7.25 10.5h9.5M4.5 14.5h15M7.25 18.5h9.5" />
  </Svg>
)
export const AlignRightIcon = () => (
  <Svg>
    <path d="M4.5 6.5h15M10 10.5h9.5M4.5 14.5h15M10 18.5h9.5" />
  </Svg>
)
export const CloseIcon = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
export const LockIcon = () => (
  <Svg>
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" />
  </Svg>
)
export const UnlockIcon = () => (
  <Svg>
    <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 016.8-1.2" />
  </Svg>
)
