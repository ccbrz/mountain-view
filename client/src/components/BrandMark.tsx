/** Brand monogram: a mountain ridge over a ruled page. Decorative only. */
export default function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`brand-mark ${className}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: size * 0.28,
        border: '1px solid rgba(214,185,124,0.45)',
        background: 'linear-gradient(160deg, rgba(214,185,124,0.18), rgba(214,185,124,0.04))',
        color: 'var(--mv-gold-strong)',
      }}
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none">
        <path
          d="M2.5 17.5 8.5 8l3.5 5.2L14.5 10l7 7.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M4 21h16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".55" />
      </svg>
    </span>
  )
}
