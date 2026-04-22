import { timingSafeEqual } from "crypto";
import { ZodError } from "zod";
import { env } from "~/env";
import {
  InboundEmailService,
  sesInboundNotificationSchema,
} from "~/server/service/inbound-email-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const payload = sesInboundNotificationSchema.parse(body);
    const result = await InboundEmailService.ingestSesNotification(payload);

    return Response.json(
      {
        data: {
          id: result.email.id,
          created: result.created,
        },
      },
      { status: result.created ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid SES inbound payload",
          details: error.flatten(),
        },
        { status: 400 }
      );
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Inbound email ingestion failed",
      },
      { status: 500 }
    );
  }
}

function isAuthorized(req: Request) {
  const configuredSecret = env.INBOUND_INTERNAL_SECRET;
  if (!configuredSecret) {
    return env.NODE_ENV !== "production";
  }

  const receivedSecret = req.headers.get("x-usesend-internal-secret");
  if (!receivedSecret) {
    return false;
  }

  const expected = Buffer.from(configuredSecret);
  const actual = Buffer.from(receivedSecret);

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
