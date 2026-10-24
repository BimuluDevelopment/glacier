import clsx from 'clsx';

const SIZES = { sm: 'size-8 text-xs rounded-md', md: 'size-10 text-sm rounded-lg', lg: 'size-14 text-lg rounded-xl', xl: 'size-24 text-3xl rounded-2xl' } as const;

/** A stable hue per name, so servers without a logo still look different from each other. */
function hue(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

export function iconUrl(serverId: string, iconVersion: number) {
  return `/api/client/servers/${serverId}/icon?v=${iconVersion}`;
}

/** A server's logo, or its initials on a colored tile when it has none. */
export function ServerLogo({ server, size = 'md', className }: { server: { id: string; name: string; iconVersion: number }; size?: keyof typeof SIZES; className?: string }) {
  if (server.iconVersion > 0) {
    return <img src={iconUrl(server.id, server.iconVersion)} alt="" className={clsx(SIZES[size], 'shrink-0 bg-surface-alt object-cover', className)} />;
  }
  return (
    <span
      aria-hidden
      className={clsx(SIZES[size], 'inline-flex shrink-0 items-center justify-center font-semibold text-white select-none', className)}
      style={{ background: `hsl(${hue(server.name)} 45% 42%)` }}
    >
      {initials(server.name)}
    </span>
  );
}
