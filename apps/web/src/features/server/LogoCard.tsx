import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Alert, Button, Card, Switch } from '../../components/ui';
import { ServerLogo } from '../../components/ServerLogo';
import { useServer } from './context';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image the browser can read."));
    img.src = url;
  });
}

/** Center-crop to a square and scale, so every logo looks right in round and square slots. */
function squareDataUrl(img: HTMLImageElement, size: number, type: 'image/webp' | 'image/png') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  // Browsers without WebP encoding hand back PNG instead, which is fine too.
  return canvas.toDataURL(type, 0.9);
}

/** Settings → Logo: the picture shown for this server across the panel. */
export function LogoCard({ minecraft }: { minecraft: boolean }) {
  const { server, can, base } = useServer();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [inGame, setInGame] = useState(minecraft);
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['server', server.id] }), qc.invalidateQueries({ queryKey: ['servers'] })]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_SOURCE_BYTES) throw new Error('Pick an image under 10 MB.');
      const img = await loadImage(file);
      const res = await api.put<{ wroteMinecraftIcon: boolean }>(`${base}/icon`, {
        image: squareDataUrl(img, 256, 'image/webp'),
        // Minecraft requires exactly 64×64 PNG for the server list picture.
        ...(minecraft && inGame ? { minecraftIcon: squareDataUrl(img, 64, 'image/png') } : {}),
      });
      return res;
    },
    onSuccess: async (res) => {
      setNote(res.wroteMinecraftIcon ? 'Saved. Players see the new icon in their server list after the next restart.' : 'Saved.');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`${base}/icon`),
    onSuccess: async () => {
      setNote(null);
      await refresh();
    },
  });

  if (!can('settings.icon')) return null;
  return (
    <Card title="Logo">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-5">
          <ServerLogo server={server} size="xl" />
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">Shown on the dashboard, the server page and in proxy networks. Square images work best; others are cropped to the middle.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<ImageUp className="size-4" />} loading={upload.isPending} onClick={() => input.current?.click()}>
                {server.iconVersion > 0 ? 'Change logo' : 'Upload logo'}
              </Button>
              {server.iconVersion > 0 && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => remove.mutate()}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
        {minecraft && (
          <Switch
            checked={inGame}
            onChange={setInGame}
            label="Also use it as the Minecraft server icon"
            description="Writes a 64×64 server-icon.png, the picture players see in their multiplayer list."
          />
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
        {(upload.error || remove.error) && <Alert>{errorMessage(upload.error ?? remove.error)}</Alert>}
        {note && !upload.error && <p className="text-sm text-success">{note}</p>}
      </div>
    </Card>
  );
}
