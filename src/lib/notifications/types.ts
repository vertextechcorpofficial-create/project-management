import { z } from "zod";

/**
 * The five recipient categories. Four map to an approval committee maintained in
 * HRM > Employee Admin > Structure > Role Management; the fifth targets named users.
 */
export const NOTIFICATION_CATEGORIES = [
    "target-review",
    "expense-review",
    "expense-approver",
    "ta-committee",
    "individual",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_KINDS = ["action", "info", "alert"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Committee rows are scoped per division or department, so the caller passes the scope. */
export const NotificationScopeSchema = z.object({
    division_id: z.number().int().positive().optional(),
    department_id: z.number().int().positive().optional(),
    /** Approval tier. Omit to address the whole chain. */
    level: z.number().int().positive().optional(),
});

export type NotificationScope = z.infer<typeof NotificationScopeSchema>;

export const EmitPayloadSchema = z
    .object({
        category: z.enum(NOTIFICATION_CATEGORIES),
        scope: NotificationScopeSchema.optional(),
        /** Required for `individual`, ignored otherwise. Capped so a bad caller cannot mass-insert. */
        user_ids: z.array(z.number().int().positive()).max(200).optional(),
        /** Subsystem slug of the caller: fm, hrm, scm, ... */
        module: z.string().trim().min(1).max(16),
        kind: z.enum(NOTIFICATION_KINDS).default("info"),
        priority: z.number().int().min(1).max(3).default(2),
        title: z.string().trim().min(1).max(160),
        body: z.string().trim().max(500).optional(),
        action_url: z.string().trim().max(255).optional(),
        entity_type: z.string().trim().max(64).optional(),
        entity_id: z.union([z.string(), z.number()]).transform(String).optional(),
        /** Collapses a retry or double submit inside a 10 minute window. */
        dedupe_key: z.string().trim().max(160).optional(),
        created_by: z.number().int().positive().optional(),
    })
    .refine((v) => v.category !== "individual" || (v.user_ids?.length ?? 0) > 0, {
        message: "user_ids is required when category is individual",
        path: ["user_ids"],
    })
    .refine(
        (v) => {
            if (v.category === "expense-review" || v.category === "expense-approver") {
                return typeof v.scope?.division_id === "number";
            }
            if (v.category === "ta-committee") {
                return typeof v.scope?.department_id === "number";
            }
            return true;
        },
        {
            message: "scope is required for this category: division_id for expense categories, department_id for ta-committee",
            path: ["scope"],
        },
    );

export type EmitPayload = z.infer<typeof EmitPayloadSchema>;

export interface NotificationRow {
    id: number;
    user_id: number;
    category: NotificationCategory;
    kind: NotificationKind;
    priority: number;
    title: string;
    body: string | null;
    action_url: string | null;
    module: string;
    entity_type: string | null;
    entity_id: string | null;
    dedupe_key: string | null;
    is_read: number | boolean;
    read_at: string | null;
    created_at: string;
    created_by: number | null;
}

export interface NotificationInbox {
    items: NotificationRow[];
    unread: number;
}

export const MarkReadSchema = z
    .object({
        ids: z.array(z.number().int().positive()).max(200).optional(),
        all: z.boolean().optional(),
    })
    .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, {
        message: "either all: true or a non-empty ids array is required",
        path: ["ids"],
    });
