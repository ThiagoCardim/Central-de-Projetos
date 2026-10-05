// Marca do Portal. O símbolo é provisório: substitua `public/logo.svg` pela
// arte oficial da YouCon e troque <BrandMark/> por <img src="/logo.svg" />.
export function BrandMark({ className = "brand__mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="yc-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5a00" />
          <stop offset="1" stopColor="#ff3000" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#yc-g)" />
      <path d="M9 9l7 8 7-8M16 17v7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="brand">
      <BrandMark />
      {!compact && (
        <span className="brand__text">
          <span className="brand__name">YouCon</span>
          <span className="brand__product">Portal de Projetos</span>
        </span>
      )}
    </div>
  );
}
