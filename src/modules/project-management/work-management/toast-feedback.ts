import { toast } from "sonner";

export function workMutationSuccess(path: string, method: string) {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  let message = method === "PATCH" ? "Work item updated." : "Work item created.";
  if (normalized === "tasks" && method === "POST") message = "Task created and assigned.";
  else if (normalized.startsWith("tasks/") && method === "PATCH") message = "Task updated.";
  else if (normalized.includes("/submissions")) message = "Submission sent.";
  else if (normalized.includes("/comments")) message = "Comment posted.";
  else if (normalized.includes("/acknowledge")) message = "Task update acknowledged.";
  else if (normalized.includes("/cancel-occurrence") || normalized.endsWith("/cancel")) message = "Work item cancelled.";
  else if (normalized.endsWith("/pause")) message = "Task paused.";
  else if (normalized.endsWith("/resume")) message = "Task resumed.";
  else if (normalized.endsWith("/archive")) message = "Task archived.";
  else if (normalized.includes("/deadline")) message = "Deadline updated.";
  toast.success(message);
}

export function workMutationError(error: unknown, fallback = "Work Management action failed.") {
  toast.error(error instanceof Error ? error.message : fallback);
}
