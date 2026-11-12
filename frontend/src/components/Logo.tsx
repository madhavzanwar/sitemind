export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden>
      <defs>
        <linearGradient id="lg-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFC757" />
          <stop offset="1" stopColor="#F59E0B" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="35" height="35" rx="10" fill="#0E121A" stroke="rgba(255,255,255,0.08)" />
      <path d="M9 24.5 18 10l9 14.5" fill="none" stroke="url(#lg-a)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 24.5h11" stroke="rgba(255,255,255,0.25)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="19.5" r="2.4" fill="#FFB224" />
    </svg>
  )
}
