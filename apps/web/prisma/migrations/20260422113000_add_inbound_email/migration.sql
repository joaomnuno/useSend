-- CreateEnum
CREATE TYPE "InboundEmailProvider" AS ENUM ('SES');

-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" TEXT NOT NULL,
    "provider" "InboundEmailProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "teamId" INTEGER NOT NULL,
    "domainId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "bcc" TEXT[],
    "replyTo" TEXT[],
    "subject" TEXT,
    "text" TEXT,
    "html" TEXT,
    "headers" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sourceBucket" TEXT,
    "sourceObjectKey" TEXT,
    "rawStorageBucket" TEXT,
    "rawStorageKey" TEXT,
    "rawSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmailAttachment" (
    "id" TEXT NOT NULL,
    "inboundEmailId" TEXT NOT NULL,
    "filename" TEXT,
    "contentType" TEXT,
    "contentDisposition" TEXT,
    "contentId" TEXT,
    "size" INTEGER,
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundEmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_provider_externalId_key" ON "InboundEmail"("provider", "externalId");

-- CreateIndex
CREATE INDEX "InboundEmail_teamId_domainId_createdAt_idx" ON "InboundEmail"("teamId", "domainId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "InboundEmail_createdAt_idx" ON "InboundEmail"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "InboundEmailAttachment_inboundEmailId_idx" ON "InboundEmailAttachment"("inboundEmailId");

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEmailAttachment" ADD CONSTRAINT "InboundEmailAttachment_inboundEmailId_fkey" FOREIGN KEY ("inboundEmailId") REFERENCES "InboundEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
