import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAwsSend,
  mockDb,
  mockGetDocumentDownloadUrl,
  mockIsStorageConfigured,
  mockPutDocument,
  mockSimpleParser,
  mockWebhookEmit,
} = vi.hoisted(() => ({
  mockAwsSend: vi.fn(),
  mockDb: {
    domain: {
      findMany: vi.fn(),
    },
    inboundEmail: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    inboundEmailAttachment: {
      create: vi.fn(),
    },
  },
  mockGetDocumentDownloadUrl: vi.fn(),
  mockIsStorageConfigured: vi.fn(),
  mockPutDocument: vi.fn(),
  mockSimpleParser: vi.fn(),
  mockWebhookEmit: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
  S3Client: class {
    public send = mockAwsSend;
  },
}));

vi.mock("mailparser", () => ({
  simpleParser: mockSimpleParser,
}));

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("~/server/service/storage-service", () => ({
  getDocumentDownloadUrl: mockGetDocumentDownloadUrl,
  isStorageConfigured: mockIsStorageConfigured,
  putDocument: mockPutDocument,
}));

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    emit: mockWebhookEmit,
  },
}));

import { InboundEmailService } from "~/server/service/inbound-email-service";

describe("InboundEmailService", () => {
  beforeEach(() => {
    mockAwsSend.mockReset();
    mockDb.domain.findMany.mockReset();
    mockDb.inboundEmail.create.mockReset();
    mockDb.inboundEmail.findFirst.mockReset();
    mockDb.inboundEmail.findUnique.mockReset();
    mockDb.inboundEmail.update.mockReset();
    mockDb.inboundEmailAttachment.create.mockReset();
    mockGetDocumentDownloadUrl.mockReset();
    mockIsStorageConfigured.mockReset();
    mockPutDocument.mockReset();
    mockSimpleParser.mockReset();
    mockWebhookEmit.mockReset();

    mockIsStorageConfigured.mockReturnValue(true);
    mockWebhookEmit.mockResolvedValue(undefined);
    mockAwsSend.mockResolvedValue({
      Body: {
        transformToByteArray: vi
          .fn()
          .mockResolvedValue(Uint8Array.from(Buffer.from("raw message"))),
      },
    });
  });

  it("ingests an SES inbound message, stores attachments, and emits email.received", async () => {
    const receivedAt = new Date("2026-04-22T10:00:00.000Z");
    const createdAt = new Date("2026-04-22T10:00:01.000Z");

    mockDb.inboundEmail.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "in_123",
        provider: "SES",
        externalId: "ses-message-1",
        teamId: 7,
        domainId: 42,
        from: "sender@example.com",
        to: ["reply@inbound.example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Hello there",
        text: "hello",
        html: "<p>hello</p>",
        headers: [
          {
            name: "Subject",
            value: "Hello there",
          },
        ],
        receivedAt,
        sourceBucket: "ses-bucket",
        sourceObjectKey: "emails/message-1",
        rawStorageBucket: "unsend",
        rawStorageKey: "inbound/raw/in_123.eml",
        rawSize: 11,
        createdAt,
        updatedAt: createdAt,
        attachments: [
          {
            id: "att_123",
            inboundEmailId: "in_123",
            filename: "hello.txt",
            contentType: "text/plain",
            contentDisposition: "attachment",
            contentId: null,
            size: 5,
            storageBucket: "unsend",
            storageKey: "inbound/attachments/in_123/0-hello.txt",
            createdAt,
          },
        ],
      });

    mockSimpleParser.mockResolvedValue({
      from: {
        value: [{ address: "sender@example.com" }],
      },
      to: {
        value: [{ address: "reply@inbound.example.com" }],
      },
      cc: null,
      bcc: null,
      replyTo: null,
      subject: "Hello there",
      text: "hello",
      html: "<p>hello</p>",
      attachments: [
        {
          filename: "hello.txt",
          contentType: "text/plain",
          contentDisposition: "attachment",
          cid: undefined,
          size: 5,
          content: Buffer.from("hello"),
        },
      ],
    });

    mockDb.domain.findMany.mockResolvedValue([
      {
        id: 42,
        name: "inbound.example.com",
        teamId: 7,
      },
    ]);

    mockDb.inboundEmail.create.mockResolvedValue({
      id: "in_123",
      provider: "SES",
      externalId: "ses-message-1",
      teamId: 7,
      domainId: 42,
      from: "sender@example.com",
      to: ["reply@inbound.example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Hello there",
      text: "hello",
      html: "<p>hello</p>",
      headers: [
        {
          name: "Subject",
          value: "Hello there",
        },
      ],
      receivedAt,
      sourceBucket: "ses-bucket",
      sourceObjectKey: "emails/message-1",
      rawStorageBucket: null,
      rawStorageKey: null,
      rawSize: 11,
      createdAt,
      updatedAt: createdAt,
    });

    mockPutDocument
      .mockResolvedValueOnce({
        bucket: "unsend",
        key: "inbound/raw/in_123.eml",
      })
      .mockResolvedValueOnce({
        bucket: "unsend",
        key: "inbound/attachments/in_123/0-hello.txt",
      });

    mockDb.inboundEmail.update.mockResolvedValue({
      id: "in_123",
    });

    mockDb.inboundEmailAttachment.create.mockResolvedValue({
      id: "att_123",
      inboundEmailId: "in_123",
      filename: "hello.txt",
      contentType: "text/plain",
      contentDisposition: "attachment",
      contentId: null,
      size: 5,
      storageBucket: "unsend",
      storageKey: "inbound/attachments/in_123/0-hello.txt",
      createdAt,
    });

    const result = await InboundEmailService.ingestSesNotification({
      mail: {
        messageId: "ses-message-1",
        source: "sender@example.com",
        destination: ["reply@inbound.example.com"],
        timestamp: receivedAt.toISOString(),
        headers: [
          {
            name: "Subject",
            value: "Hello there",
          },
        ],
        commonHeaders: {
          subject: "Hello there",
        },
      },
      receipt: {
        recipients: ["reply@inbound.example.com"],
        timestamp: receivedAt.toISOString(),
      },
      s3: {
        bucket: "ses-bucket",
        key: "emails/message-1",
        region: "us-east-1",
      },
    });

    expect(result.created).toBe(true);
    expect(mockPutDocument).toHaveBeenCalledTimes(2);
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      7,
      "email.received",
      expect.objectContaining({
        id: "in_123",
        externalId: "ses-message-1",
        attachments: [
          expect.objectContaining({
            id: "att_123",
            filename: "hello.txt",
          }),
        ],
      }),
      {
        domainId: 42,
      }
    );
  });

  it("returns an existing inbound message without reprocessing retries", async () => {
    mockDb.inboundEmail.findUnique.mockResolvedValue({
      id: "in_123",
      provider: "SES",
      externalId: "ses-message-1",
      teamId: 7,
      domainId: 42,
      from: "sender@example.com",
      to: ["reply@inbound.example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Hello there",
      text: "hello",
      html: "<p>hello</p>",
      headers: [],
      receivedAt: new Date("2026-04-22T10:00:00.000Z"),
      sourceBucket: "ses-bucket",
      sourceObjectKey: "emails/message-1",
      rawStorageBucket: null,
      rawStorageKey: null,
      rawSize: 11,
      createdAt: new Date("2026-04-22T10:00:01.000Z"),
      updatedAt: new Date("2026-04-22T10:00:01.000Z"),
      attachments: [],
    });

    const result = await InboundEmailService.ingestSesNotification({
      mail: {
        messageId: "ses-message-1",
        headers: [],
      },
      receipt: {
        recipients: ["reply@inbound.example.com"],
      },
      s3: {
        bucket: "ses-bucket",
        key: "emails/message-1",
      },
    });

    expect(result.created).toBe(false);
    expect(mockSimpleParser).not.toHaveBeenCalled();
    expect(mockWebhookEmit).not.toHaveBeenCalled();
  });

  it("handles race conditions by returning the existing inbound email on unique conflicts", async () => {
    const receivedAt = new Date("2026-04-22T10:00:00.000Z");
    const createdAt = new Date("2026-04-22T10:00:01.000Z");

    mockDb.inboundEmail.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "in_123",
        provider: "SES",
        externalId: "ses-message-1",
        teamId: 7,
        domainId: 42,
        from: "sender@example.com",
        to: ["reply@inbound.example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "Hello there",
        text: "hello",
        html: "<p>hello</p>",
        headers: [],
        receivedAt,
        sourceBucket: "ses-bucket",
        sourceObjectKey: "emails/message-1",
        rawStorageBucket: null,
        rawStorageKey: null,
        rawSize: 11,
        createdAt,
        updatedAt: createdAt,
        attachments: [],
      });

    mockSimpleParser.mockResolvedValue({
      from: {
        value: [{ address: "sender@example.com" }],
      },
      to: {
        value: [{ address: "reply@inbound.example.com" }],
      },
      cc: null,
      bcc: null,
      replyTo: null,
      subject: "Hello there",
      text: "hello",
      html: "<p>hello</p>",
      attachments: [],
    });

    mockDb.domain.findMany.mockResolvedValue([
      {
        id: 42,
        name: "inbound.example.com",
        teamId: 7,
      },
    ]);

    mockDb.inboundEmail.create.mockRejectedValue(
      new PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const result = await InboundEmailService.ingestSesNotification({
      mail: {
        messageId: "ses-message-1",
        source: "sender@example.com",
        destination: ["reply@inbound.example.com"],
        timestamp: receivedAt.toISOString(),
        headers: [],
      },
      receipt: {
        recipients: ["reply@inbound.example.com"],
        timestamp: receivedAt.toISOString(),
      },
      s3: {
        bucket: "ses-bucket",
        key: "emails/message-1",
        region: "us-east-1",
      },
    });

    expect(result.created).toBe(false);
    expect(mockPutDocument).not.toHaveBeenCalled();
    expect(mockWebhookEmit).not.toHaveBeenCalled();
  });

  it("returns signed download URLs for raw MIME and attachments", async () => {
    mockDb.inboundEmail.findFirst.mockResolvedValue({
      id: "in_123",
      provider: "SES",
      externalId: "ses-message-1",
      teamId: 7,
      domainId: 42,
      from: "sender@example.com",
      to: ["reply@inbound.example.com"],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: "Hello there",
      text: "hello",
      html: "<p>hello</p>",
      headers: [],
      receivedAt: new Date("2026-04-22T10:00:00.000Z"),
      sourceBucket: "ses-bucket",
      sourceObjectKey: "emails/message-1",
      rawStorageBucket: "unsend",
      rawStorageKey: "inbound/raw/in_123.eml",
      rawSize: 11,
      createdAt: new Date("2026-04-22T10:00:01.000Z"),
      updatedAt: new Date("2026-04-22T10:00:01.000Z"),
      attachments: [
        {
          id: "att_123",
          inboundEmailId: "in_123",
          filename: "hello.txt",
          contentType: "text/plain",
          contentDisposition: "attachment",
          contentId: null,
          size: 5,
          storageBucket: "unsend",
          storageKey: "inbound/attachments/in_123/0-hello.txt",
          createdAt: new Date("2026-04-22T10:00:01.000Z"),
        },
      ],
    });

    mockGetDocumentDownloadUrl
      .mockResolvedValueOnce("https://storage.test/raw")
      .mockResolvedValueOnce("https://storage.test/attachment");

    const result = await InboundEmailService.getInboundEmail({
      emailId: "in_123",
      teamId: 7,
      domainId: 42,
    });

    expect(result.raw?.downloadUrl).toBe("https://storage.test/raw");
    expect(result.attachments[0]?.downloadUrl).toBe(
      "https://storage.test/attachment"
    );
  });
});
