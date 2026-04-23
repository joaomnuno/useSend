import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  type InboundEmailAttachment,
  type Prisma,
} from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { type AddressObject, type Attachment, simpleParser } from "mailparser";
import { z } from "zod";
import { env } from "~/env";
import { db } from "../db";
import { logger } from "../logger/log";
import { UnsendApiError } from "../public-api/api-error";
import {
  getDocumentDownloadUrl,
  isStorageConfigured,
  putDocument,
} from "./storage-service";
import { WebhookService } from "./webhook-service";

const sesHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const sesInboundNotificationSchema = z.object({
  mail: z.object({
    messageId: z.string().min(1),
    source: z.string().optional(),
    destination: z.array(z.string()).optional(),
    timestamp: z.string().optional(),
    headers: z.array(sesHeaderSchema).default([]),
    commonHeaders: z
      .object({
        subject: z.string().optional(),
      })
      .optional(),
  }),
  receipt: z.object({
    recipients: z.array(z.string()).min(1),
    timestamp: z.string().optional(),
  }),
  s3: z.object({
    bucket: z.string().min(1),
    key: z.string().min(1),
    region: z.string().optional(),
  }),
});

export type SesInboundNotification = z.infer<typeof sesInboundNotificationSchema>;

type InboundHeader = z.infer<typeof sesHeaderSchema>;
const SES_PROVIDER = "SES" as const;

type InboundEmailWithAttachments = Prisma.InboundEmailGetPayload<{
  include: {
    attachments: true;
  };
}>;

export class InboundEmailService {
  public static async ingestSesNotification(payload: SesInboundNotification) {
    const existing = await db.inboundEmail.findUnique({
      where: {
        provider_externalId: {
          provider: SES_PROVIDER,
          externalId: payload.mail.messageId,
        },
      },
      include: {
        attachments: true,
      },
    });

    if (existing) {
      return {
        created: false,
        email: existing,
      };
    }

    const rawEmail = await getRawEmailFromS3(payload.s3);
    assertInboundRawEmailSize(rawEmail.length);
    const parsedEmail = await simpleParser(rawEmail);
    const receivedAt = getReceivedAt(payload);
    const recipients = dedupeStrings([
      ...normalizeAddresses(parsedEmail.to),
      ...payload.receipt.recipients,
    ]);
    const domain = await resolveInboundDomain(recipients);
    const from = normalizeAddresses(parsedEmail.from)[0] ?? payload.mail.source ?? "";

    if (!from) {
      throw new Error("Inbound email is missing a sender address");
    }

    const createdInboundEmail = await createInboundEmail({
      payload,
      domain,
      from,
      recipients,
      parsedEmail,
      receivedAt,
      rawSize: rawEmail.length,
    });

    if (!createdInboundEmail.created) {
      return createdInboundEmail;
    }

    const inboundEmail = createdInboundEmail.email;

    const rawStorage = await uploadRawEmailIfConfigured(inboundEmail.id, rawEmail);
    if (rawStorage) {
      await db.inboundEmail.update({
        where: {
          id: inboundEmail.id,
        },
        data: {
          rawStorageBucket: rawStorage.bucket,
          rawStorageKey: rawStorage.key,
        },
      });
    }

    const attachments = await persistAttachments({
      inboundEmailId: inboundEmail.id,
      attachments: parsedEmail.attachments,
    });

    const email = await db.inboundEmail.findUnique({
      where: {
        id: inboundEmail.id,
      },
      include: {
        attachments: true,
      },
    });

    if (!email) {
      throw new Error("Inbound email could not be reloaded after creation");
    }

    try {
      await WebhookService.emit(
        email.teamId,
        "email.received",
        buildEmailReceivedPayload(email, attachments),
        {
          domainId: email.domainId,
        }
      );
    } catch (error) {
      logger.error(
        {
          error,
          emailId: email.id,
        },
        "[InboundEmailService]: Failed to emit email.received webhook"
      );
    }

    return {
      created: true,
      email,
    };
  }

  public static async getInboundEmail(params: {
    emailId: string;
    teamId: number;
    domainId?: number | null;
  }) {
    const email = await db.inboundEmail.findFirst({
      where: {
        id: params.emailId,
        teamId: params.teamId,
        ...(params.domainId != null ? { domainId: params.domainId } : {}),
      },
      include: {
        attachments: true,
      },
    });

    if (!email) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Inbound email not found",
      });
    }

    return {
      id: email.id,
      provider: "ses" as const,
      externalId: email.externalId,
      domainId: email.domainId,
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: (email.headers as InboundHeader[] | null) ?? [],
      receivedAt: email.receivedAt.toISOString(),
      createdAt: email.createdAt.toISOString(),
      updatedAt: email.updatedAt.toISOString(),
      raw: await buildRawPayload(email),
      attachments: await Promise.all(
        email.attachments.map(async (attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.contentId,
          size: attachment.size,
          downloadUrl: await getAttachmentDownloadUrl(attachment),
        }))
      ),
    };
  }
}

async function createInboundEmail(params: {
  payload: SesInboundNotification;
  domain: { id: number; teamId: number };
  from: string;
  recipients: string[];
  parsedEmail: Awaited<ReturnType<typeof simpleParser>>;
  receivedAt: Date;
  rawSize: number;
}) {
  try {
    const email = await db.inboundEmail.create({
      data: {
        provider: SES_PROVIDER,
        externalId: params.payload.mail.messageId,
        teamId: params.domain.teamId,
        domainId: params.domain.id,
        from: params.from,
        to: params.recipients,
        cc: normalizeAddresses(params.parsedEmail.cc),
        bcc: normalizeAddresses(params.parsedEmail.bcc),
        replyTo: normalizeAddresses(params.parsedEmail.replyTo),
        subject:
          params.parsedEmail.subject ?? params.payload.mail.commonHeaders?.subject ?? null,
        text: params.parsedEmail.text ?? null,
        html: normalizeHtml(params.parsedEmail.html),
        headers: params.payload.mail.headers as Prisma.InputJsonValue,
        receivedAt: params.receivedAt,
        sourceBucket: params.payload.s3.bucket,
        sourceObjectKey: params.payload.s3.key,
        rawSize: params.rawSize,
      },
    });

    return {
      created: true as const,
      email,
    };
  } catch (error) {
    if (!isUniqueInboundConflict(error)) {
      throw error;
    }

    const email = await db.inboundEmail.findUnique({
      where: {
        provider_externalId: {
          provider: SES_PROVIDER,
          externalId: params.payload.mail.messageId,
        },
      },
      include: {
        attachments: true,
      },
    });

    if (!email) {
      throw error;
    }

    return {
      created: false as const,
      email,
    };
  }
}

function getAwsS3Client(region: string) {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY,
      secretAccessKey: env.AWS_SECRET_KEY,
    },
  });
}

async function getRawEmailFromS3(params: {
  bucket: string;
  key: string;
  region?: string;
}) {
  const client = getAwsS3Client(params.region ?? env.AWS_DEFAULT_REGION);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    })
  );

  if (!response.Body) {
    throw new Error("Inbound email S3 object did not contain a body");
  }

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

async function resolveInboundDomain(recipients: string[]) {
  const recipientDomains = Array.from(
    new Set(
      recipients
        .map((recipient) => getRecipientDomain(recipient))
        .filter((domain): domain is string => Boolean(domain))
    )
  );

  if (recipientDomains.length === 0) {
    throw new Error("Inbound email did not contain any valid recipients");
  }

  const domains = await db.domain.findMany({
    where: {
      name: {
        in: recipientDomains,
      },
    },
    select: {
      id: true,
      name: true,
      teamId: true,
    },
  });

  const matchedDomainIds = Array.from(
    new Set(
      recipientDomains
        .map((domainName) => domains.find((domain) => domain.name === domainName)?.id)
        .filter((domainId): domainId is number => domainId !== undefined)
    )
  );

  if (matchedDomainIds.length === 0) {
    throw new Error("Inbound email does not target a configured domain");
  }

  if (matchedDomainIds.length > 1) {
    throw new Error(
      "Inbound email matched multiple configured domains; a single message must target one useSend domain"
    );
  }

  const domain = domains.find((item) => item.id === matchedDomainIds[0]);
  if (!domain) {
    throw new Error("Inbound email domain resolution failed");
  }

  return domain;
}

async function uploadRawEmailIfConfigured(inboundEmailId: string, rawEmail: Buffer) {
  if (!isStorageConfigured()) {
    return null;
  }

  try {
    return await putDocument({
      key: `inbound/raw/${inboundEmailId}.eml`,
      body: rawEmail,
      fileType: "message/rfc822",
    });
  } catch (error) {
    logger.error(
      {
        error,
        inboundEmailId,
      },
      "[InboundEmailService]: Failed to upload raw email"
    );
    return null;
  }
}

async function persistAttachments(params: {
  inboundEmailId: string;
  attachments: Attachment[];
}) {
  const rows: InboundEmailAttachment[] = [];

  for (const [index, attachment] of params.attachments.entries()) {
    let storageBucket: string | null = null;
    let storageKey: string | null = null;

    if (isStorageConfigured()) {
      try {
        const uploaded = await putDocument({
          key: `inbound/attachments/${params.inboundEmailId}/${index}-${sanitizeFileName(
            attachment.filename ?? "attachment"
          )}`,
          body: attachment.content,
          fileType: attachment.contentType || "application/octet-stream",
        });
        storageBucket = uploaded.bucket;
        storageKey = uploaded.key;
      } catch (error) {
        logger.error(
          {
            error,
            inboundEmailId: params.inboundEmailId,
            attachmentIndex: index,
          },
          "[InboundEmailService]: Failed to upload inbound attachment"
        );
      }
    }

    const row = await db.inboundEmailAttachment.create({
      data: {
        inboundEmailId: params.inboundEmailId,
        filename: attachment.filename ?? null,
        contentType: attachment.contentType || null,
        contentDisposition: attachment.contentDisposition ?? null,
        contentId: attachment.cid ?? null,
        size: attachment.size ?? attachment.content.length,
        storageBucket,
        storageKey,
      },
    });

    rows.push(row);
  }

  return rows;
}

async function buildRawPayload(email: InboundEmailWithAttachments) {
  if (!email.rawStorageBucket || !email.rawStorageKey || !isStorageConfigured()) {
    return null;
  }

  return {
    size: email.rawSize,
    downloadUrl: await getDocumentDownloadUrl({
      bucket: email.rawStorageBucket,
      key: email.rawStorageKey,
      fileName: `${email.id}.eml`,
    }),
  };
}

async function getAttachmentDownloadUrl(attachment: InboundEmailAttachment) {
  if (!attachment.storageBucket || !attachment.storageKey || !isStorageConfigured()) {
    return null;
  }

  return getDocumentDownloadUrl({
    bucket: attachment.storageBucket,
    key: attachment.storageKey,
    fileName: attachment.filename,
  });
}

function buildEmailReceivedPayload(
  email: InboundEmailWithAttachments,
  attachments: InboundEmailAttachment[]
) {
  return {
    id: email.id,
    provider: "ses" as const,
    externalId: email.externalId,
    receivedAt: email.receivedAt.toISOString(),
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    subject: email.subject,
    domainId: email.domainId,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

function normalizeAddresses(
  addressObject?: AddressObject | AddressObject[] | null
) {
  if (!addressObject) {
    return [];
  }

  const values = Array.isArray(addressObject)
    ? addressObject.flatMap((entry) => entry.value)
    : addressObject.value;

  return dedupeStrings(
    values
      .map((entry) => entry.address?.trim())
      .filter((entry): entry is string => Boolean(entry))
  );
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function getRecipientDomain(recipient: string) {
  const atIndex = recipient.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }

  return recipient.slice(atIndex + 1).toLowerCase();
}

function getReceivedAt(payload: SesInboundNotification) {
  const timestamp = payload.receipt.timestamp ?? payload.mail.timestamp;
  if (!timestamp) {
    return new Date();
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function normalizeHtml(html: string | false | undefined) {
  if (!html) {
    return null;
  }

  return html;
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isUniqueInboundConflict(error: unknown) {
  return error instanceof PrismaClientKnownRequestError && error.code === "P2002";
}

function assertInboundRawEmailSize(rawSize: number) {
  const maxBytes = env.INBOUND_MAX_RAW_EMAIL_BYTES ?? 20 * 1024 * 1024;
  if (rawSize <= maxBytes) {
    return;
  }

  throw new Error(
    `Inbound email exceeds configured size limit (${rawSize} bytes > ${maxBytes} bytes)`
  );
}
