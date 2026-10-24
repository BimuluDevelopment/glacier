import type { Egg, EggVariable, ServerVariable } from '@prisma/client';
import type { Loader, MinecraftContext } from '@glacier/shared';

/** Egg variables that hold the Minecraft version in common eggs (ours and Pterodactyl's). */
export const VERSION_VARIABLES = ['MINECRAFT_VERSION', 'MC_VERSION', 'VANILLA_VERSION'] as const;

type ServerWithEgg = { egg: Egg & { variables: EggVariable[] }; variables: ServerVariable[] };

export function detectLoader(eggName: string): Loader | null {
  const n = eggName.toLowerCase();
  if (n.includes('neoforge')) return 'neoforge';
  if (n.includes('forge')) return 'forge';
  if (n.includes('quilt')) return 'quilt';
  if (n.includes('fabric')) return 'fabric';
  if (n.includes('folia')) return 'folia';
  if (n.includes('purpur')) return 'purpur';
  if (n.includes('velocity')) return 'velocity';
  if (n.includes('paper') || n.includes('spigot') || n.includes('bukkit')) return 'paper';
  return null;
}

/** The server's Minecraft version variable and its current value, if the egg has one. */
export function versionVariable(server: ServerWithEgg) {
  const variable = server.egg.variables.find((v) => (VERSION_VARIABLES as readonly string[]).includes(v.envVariable));
  if (!variable) return null;
  const value = server.variables.find((sv) => sv.variableId === variable.id)?.value ?? variable.defaultValue;
  return { variable, value };
}

export function minecraftContext(server: ServerWithEgg): MinecraftContext {
  const loader = detectLoader(server.egg.name);
  const version = versionVariable(server);
  const gameVersion = version && /^\d+(\.\d+)+$/.test(version.value) ? version.value : null;
  const name = server.egg.name.toLowerCase();
  const versionSource = !version
    ? null
    : loader === 'purpur'
      ? 'purpur'
      : loader === 'paper'
        ? 'paper'
        : loader === 'fabric'
          ? 'fabric'
          : name.includes('vanilla') || name.includes('minecraft')
            ? 'vanilla'
            : null;
  return { loader, gameVersion, versionSource };
}
