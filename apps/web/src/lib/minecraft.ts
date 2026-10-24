/** Minecraft: Java servers and proxies, judged by egg name (ours and Pterodactyl's). */
export const isMinecraft = (eggName: string) => /minecraft|paper|purpur|spigot|bukkit|fabric|forge|quilt|folia|velocity|bungee|waterfall/i.test(eggName);
