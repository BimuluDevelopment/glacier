-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "forwardingSecret" TEXT,
ADD COLUMN     "iconVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "networkCpuLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "networkDiskLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "networkFallback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "networkForcedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "networkManaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "networkMemoryLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "networkName" TEXT,
ADD COLUMN     "networkOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "networkServerLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proxyId" INTEGER;

-- CreateTable
CREATE TABLE "ServerIcon" (
    "serverId" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "type" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerIcon_pkey" PRIMARY KEY ("serverId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Server_proxyId_networkName_key" ON "Server"("proxyId", "networkName");

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerIcon" ADD CONSTRAINT "ServerIcon_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

