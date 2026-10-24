import { useId, useMemo, useState } from 'react';
import type { ResourceSample } from '@glacier/shared';

/**
 * A small area chart for one metric over the last hour. Gaps longer than 30 s (server offline)
 * break the line instead of drawing a misleading slope across them.
 */
export function ResourceChart({
  samples,
  label,
  value,
  format,
  max,
}: {
  samples: ResourceSample[];
  label: string;
  value: (s: ResourceSample) => number;
  format: (v: number) => string;
  /** Fixed top of the scale (e.g. the memory limit); otherwise the data's peak. */
  max?: number;
}) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 120;

  const { segments, top, points } = useMemo(() => {
    const now = Date.now();
    const start = now - 60 * 60_000;
    const peak = Math.max(1e-9, max ?? 0, ...samples.map(value));
    const pts = samples.filter((s) => s.t >= start).map((s) => ({ s, x: ((s.t - start) / (now - start)) * W, y: H - (value(s) / peak) * (H - 8) }));
    const segs: (typeof pts)[] = [];
    for (const p of pts) {
      const last = segs.at(-1)?.at(-1);
      if (!last || p.s.t - last.s.t > 30_000) segs.push([p]);
      else segs.at(-1)!.push(p);
    }
    return { segments: segs, top: peak, points: pts };
  }, [samples, value, max]);

  const current = hover !== null ? points[hover] : points.at(-1);

  return (
    <div className="rounded-ui border border-border bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label} · last hour</span>
        <span className="text-sm font-semibold tabular-nums">
          {current ? format(value(current.s)) : '—'}
          {hover !== null && current && <span className="ml-2 text-xs font-normal text-muted">{new Date(current.s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        </span>
      </div>
      {points.length < 2 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted">Collecting data while the server runs…</div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-[120px] w-full"
          role="img"
          aria-label={`${label} over the last hour, now ${current ? format(value(current.s)) : 'unknown'}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * W;
            let best = 0;
            points.forEach((p, i) => {
              if (Math.abs(p.x - x) < Math.abs(points[best]!.x - x)) best = i;
            });
            setHover(best);
          }}
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--sl-primary)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--sl-primary)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--sl-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 4" />
          ))}
          {segments.map((seg, i) => {
            const line = seg.map((p, j) => `${j ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
            return (
              <g key={i}>
                <path d={`${line}L${seg.at(-1)!.x.toFixed(1)},${H}L${seg[0]!.x.toFixed(1)},${H}Z`} fill={`url(#${gradient})`} />
                <path d={line} fill="none" stroke="var(--sl-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </g>
            );
          })}
          {hover !== null && points[hover] && (
            <line x1={points[hover]!.x} x2={points[hover]!.x} y1="0" y2={H} stroke="var(--sl-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      )}
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>60 min ago</span>
        <span>peak {format(top)}</span>
        <span>now</span>
      </div>
    </div>
  );
}
