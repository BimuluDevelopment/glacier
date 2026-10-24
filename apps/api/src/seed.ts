import { prisma } from './db';
import { ensureBundledEggs } from './modules/eggs/service';

// Seeds the bundled eggs and a default location. Users are created through the setup wizard.
await ensureBundledEggs();
await prisma.location.upsert({ where: { short: 'default' }, create: { short: 'default', long: 'Default location' }, update: {} });
console.log('Seeded bundled eggs and the default location.');
await prisma.$disconnect();
