import { NextRequest, NextResponse } from "next/server";

import { notify } from "@/lib/notifications/emitter";
import { EmitPayloadSchema } from "@/lib/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * HTTP entry point for callers outside the Next app (Spring, scripts).
 * Server-to-server only: the shared secret is never shipped to a browser.
 */
export async function POST(req: NextRequest) {
    const expected = process.env.NOTIFICATIONS_EMIT_TOKEN;
    if (!expected) {
        return NextResponse.json({ success: false, message: "Emit endpoint is not configured" }, { status: 503 });
    }

    if (req.headers.get("x-internal-token") !== expected) {
        return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const parsed = EmitPayloadSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            { success: false, message: "Invalid payload", errors: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }

    const result = await notify(parsed.data);

    if (result.skipped === "provider-error") {
        return NextResponse.json({ success: false, message: "Notification store unavailable", data: result }, { status: 502 });
    }

    return NextResponse.json({ success: true, data: result });
}
