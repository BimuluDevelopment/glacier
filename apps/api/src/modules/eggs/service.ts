import type { Egg, EggVariable, Prisma } from '@prisma/client';
import { BUNDLED_EGGS, parseEgg, type EggDefinition } from '@glacier/eggs';
import { prisma } from '../../db';

export function eggData(def: EggDefinition) {
  return {
    name: def.name,
    author: def.author,
    description: def.description,
    features: def.features,
    dockerImages: def.dockerImages,
    fileDenylist: def.fileDenylist,
    startup: def.startup,
    configFiles: def.config.files as unknown as Prisma.InputJsonObject,
    startupDone: def.config.startupDone,
    stopCommand: def.config.stop,
    installScript: def.install.script,
    installContainer: def.install.container,
    installEntrypoint: def.install.entrypoint,
  };
}

/**
 * Create or update an egg from a parsed definition. Existing variables are updated in place (by
 * env variable name) so servers keep their values; variables removed from the egg are deleted.
 */
export async function upsertEgg(nestId: number, def: EggDefinition, existingId?: number) {
  return prisma.$transaction(async (tx) => {
    const egg = existingId
      ? await tx.egg.update({ where: { id: existingId }, data: eggData(def) })
      : await tx.egg.create({ data: { ...eggData(def), nestId, ...(def.uuid ? { uuid: def.uuid } : {}) } });

    const keep = def.variables.map((v) => v.envVariable);
    await tx.eggVariable.deleteMany({ where: { eggId: egg.id, envVariable: { notIn: keep } } });
    for (const [sort, v] of def.variables.entries()) {
      const data = {
        name: v.name,
        description: v.description,
        defaultValue: v.defaultValue,
        userViewable: v.userViewable,
        userEditable: v.userEditable,
        rules: v.rules,
        sort,
      };
      await tx.eggVariable.upsert({
        where: { eggId_envVariable: { eggId: egg.id, envVariable: v.envVariable } },
        create: { ...data, eggId: egg.id, envVariable: v.envVariable },
        update: data,
      });
    }
    return egg;
  });
}

/** Seed the bundled eggs. Safe to run repeatedly; eggs that already exist (by uuid) are left alone. */
export async function ensureBundledEggs() {
  for (const { nest, nestDescription, egg } of BUNDLED_EGGS) {
    const def = parseEgg(egg);
    if (def.uuid && (await prisma.egg.findUnique({ where: { uuid: def.uuid } }))) continue;
    const n = await prisma.nest.upsert({ where: { name: nest }, create: { name: nest, description: nestDescription }, update: {} });
    await upsertEgg(n.id, def);
  }
}

export function toDefinition(egg: Egg & { variables: EggVariable[] }): EggDefinition {
  return {
    uuid: egg.uuid,
    name: egg.name,
    author: egg.author,
    description: egg.description ?? '',
    features: egg.features,
    dockerImages: egg.dockerImages as Record<string, string>,
    fileDenylist: egg.fileDenylist,
    startup: egg.startup,
    config: {
      files: egg.configFiles as unknown as EggDefinition['config']['files'],
      startupDone: egg.startupDone,
      stop: egg.stopCommand,
    },
    install: { script: egg.installScript, container: egg.installContainer, entrypoint: egg.installEntrypoint },
    variables: [...egg.variables]
      .sort((a, b) => a.sort - b.sort)
      .map((v) => ({
        name: v.name,
        description: v.description,
        envVariable: v.envVariable,
        defaultValue: v.defaultValue,
        userViewable: v.userViewable,
        userEditable: v.userEditable,
        rules: v.rules,
      })),
  };
}
