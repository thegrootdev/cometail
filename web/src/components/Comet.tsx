// The signature animation: a comet whose tail brightens as fees flow.
// `intensity` is 0..1 and comes from live fee flow; the head stays constant.
export function Comet({ intensity = 0.4, size = 320 }: { intensity?: number; size?: number }) {
  const glow = 0.35 + Math.min(1, Math.max(0, intensity)) * 0.65;
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-label="comet" role="img">
      <defs>
        <linearGradient id="tail-ion" x1="0" x2="1">
          <stop offset="0" stopColor="#5BC8FF" stopOpacity="0" />
          <stop offset="1" stopColor="#5BC8FF" stopOpacity={glow} />
        </linearGradient>
        <linearGradient id="tail-dust" x1="0" x2="1">
          <stop offset="0" stopColor="#F5C451" stopOpacity="0" />
          <stop offset="1" stopColor="#F5C451" stopOpacity={glow} />
        </linearGradient>
      </defs>
      <image href="/brand/symbol.svg" width="1024" height="1024" style={{ filter: `drop-shadow(0 0 ${18 * glow}px rgba(91,200,255,${0.5 * glow}))`, transition: "filter 600ms ease" }} />
    </svg>
  );
}
