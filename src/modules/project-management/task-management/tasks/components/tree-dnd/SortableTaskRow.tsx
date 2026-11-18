"use client";

import { GripVertical } from "lucide-react";

import { cn } from "@/lib/utils";

import { TaskRow, type TaskRowProps } from "../TaskRow";
import { useTreeDnd } from "./TreeDndProvider";

export type SortableTaskRowProps = TaskRowProps;

/**
 * A `TaskRow` made draggable.
 *
 * The pointer handling lives in `TreeDndProvider`, which owns the whole list: it knows the gap under
 * the pointer and the level the sideways travel promises. A row's job here is small:
 * - the row being dragged keeps its SLOT but fades to 40% (`opacity-40`) and its descendants leave the
 *   list, which is exactly the reference mockup's `.task.active{opacity:.35}` — the rows below never
 *   jump while a task is in the air;
 * - it draws nothing else: the one drop line lives in the list, not in a row, so it can sit in the gap
 *   between two rows instead of on top of one;
 * - it carries the decorative grip, which is also the only place a touch drag may start (so a swipe
 *   still scrolls the list).
 *
 * The row itself is never translated: the mockup moves a chip, not the row, and a travelling row is
 * what made earlier versions look like they were shoving their neighbours out of the way.
 */
export function SortableTaskRow({ node, ...rowProps }: SortableTaskRowProps) {
    const { activeId, hiddenIds, isReorderDisabled } = useTreeDnd();

    const isGhost = activeId === node.id;
    // The dragged row keeps its slot; everything under it leaves the list with it.
    if (!isGhost && hiddenIds.has(node.id)) return null;

    const dragHandle = (
        <GripVertical
            aria-hidden="true"
            data-slot="task-tree-drag-handle"
            className={cn(
                "size-3.5 text-muted-foreground/60 transition-colors",
                isReorderDisabled
                    ? "opacity-30"
                    : "group-hover/row:text-muted-foreground group-focus-within/row:text-muted-foreground",
            )}
        />
    );

    return (
        <TaskRow
            {...rowProps}
            node={node}
            rowClassName={cn(
                isGhost ? "opacity-40" : undefined,
                isReorderDisabled
                    ? undefined
                    : activeId === null
                      ? "cursor-grab"
                      : "cursor-grabbing select-none",
            )}
            dragHandle={isGhost ? undefined : dragHandle}
        />
    );
}
