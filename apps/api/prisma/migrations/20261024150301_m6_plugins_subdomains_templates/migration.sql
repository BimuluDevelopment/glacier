-- CreateTable
CREATE TABLE "InstalledPlugin" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "iconUrl" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstalledPlugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subdomain" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "hostname" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "srvRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subdomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerTemplate" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "eggId" INTEGER NOT NULL,
    "image" TEXT,
    "memory" INTEGER NOT NULL,
    "swap" INTEGER NOT NULL DEFAULT 0,
    "disk" INTEGER NOT NULL,
    "cpu" INTEGER NOT NULL DEFAULT 0,
    "io" INTEGER NOT NULL DEFAULT 500,
    "databaseLimit" INTEGER NOT NULL DEFAULT 0,
    "allocationLimit" INTEGER NOT NULL DEFAULT 0,
    "backupLimit" INTEGER NOT NULL DEFAULT 0,
    "environment" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstalledPlugin_serverId_idx" ON "InstalledPlugin"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "InstalledPlugin_serverId_source_projectId_key" ON "InstalledPlugin"("serverId", "source", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Subdomain_hostname_key" ON "Subdomain"("hostname");

-- CreateIndex
CREATE INDEX "Subdomain_serverId_idx" ON "Subdomain"("serverId");

-- AddForeignKey
ALTER TABLE "InstalledPlugin" ADD CONSTRAINT "InstalledPlugin_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subdomain" ADD CONSTRAINT "Subdomain_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerTemplate" ADD CONSTRAINT "ServerTemplate_eggId_fkey" FOREIGN KEY ("eggId") REFERENCES "Egg"("id") ON DELETE CASCADE ON UPDATE CASCADE;
