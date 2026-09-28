import { useId } from 'react'

/** The Earful mark: an ear hearing sound waves, on an accent gradient tile. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7b6df6" />
          <stop offset="0.55" stopColor="#5b4fd6" />
          <stop offset="1" stopColor="#3f33b3" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${id}-bg)`} />
      <g transform="translate(-26 -6)" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path strokeWidth="40" d="M128 214 A100 100 0 1 1 328 214 C328 296 244 304 244 364 A50 50 0 0 1 144 364" />
        <path strokeWidth="32" d="M270 214 A42 42 0 0 0 186 214 V232 A30 30 0 0 1 186 292" />
        <path strokeWidth="30" strokeOpacity="0.9" d="M366 166 A150 150 0 0 1 366 342" />
        <path strokeWidth="30" strokeOpacity="0.55" d="M418 132 A205 205 0 0 1 418 376" />
      </g>
    </svg>
  )
}
