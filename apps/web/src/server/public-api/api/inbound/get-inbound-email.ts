import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { InboundEmailService } from "~/server/service/inbound-email-service";

const headerSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  contentType: z.string().nullable(),
  contentDisposition: z.string().nullable(),
  contentId: z.string().nullable(),
  size: z.number().nullable(),
  downloadUrl: z.string().url().nullable(),
});

const route = createRoute({
  method: "get",
  path: "/v1/inbound/emails/{emailId}",
  request: {
    params: z.object({
      emailId: z.string().min(3).openapi({
        param: {
          name: "emailId",
          in: "path",
        },
        example: "cm9b4w61z00008jxj8ebqs4f7",
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            provider: z.literal("ses"),
            externalId: z.string(),
            domainId: z.number(),
            from: z.string(),
            to: z.array(z.string()),
            cc: z.array(z.string()),
            bcc: z.array(z.string()),
            replyTo: z.array(z.string()),
            subject: z.string().nullable(),
            text: z.string().nullable(),
            html: z.string().nullable(),
            headers: z.array(headerSchema),
            receivedAt: z.string(),
            createdAt: z.string(),
            updatedAt: z.string(),
            raw: z
              .object({
                size: z.number().nullable(),
                downloadUrl: z.string().url(),
              })
              .nullable(),
            attachments: z.array(attachmentSchema),
          }),
        },
      },
      description: "Retrieve a received inbound email",
    },
  },
});

function getInboundEmail(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const emailId = c.req.param("emailId");

    return c.json(
      await InboundEmailService.getInboundEmail({
        emailId,
        teamId: team.id,
        domainId: team.apiKey.domainId,
      })
    );
  });
}

export default getInboundEmail;
