"use client";

import { ClipboardList } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { OverviewProps, TaskSummary } from "./workspace-types";
import { assignmentAvailability } from "./availability";
import { selectClass } from "./presentation";

export function AssignmentOverview({ bootstrap, rows, tasks: providedTasks, onOpen }: OverviewProps) {
  const availability = bootstrap ? assignmentAvailability(bootstrap) : null;
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("");
  const [priority, setPriority] = useState("");
  const [sort, setSort] = useState("created_desc");
  const fallbackTasks = useMemo<TaskSummary[]>(() => [...new Set(rows.map(row => row.task_id))].map(taskId => {
   const obligations = rows.filter(row => row.task_id === taskId);
   const first = obligations[0];
   return { id: taskId, title: first.task.title, scope_type: first.task.scope_type, priority: first.task.priority, lifecycle_status: first.task.lifecycle_status, created_at: first.task.created_at, department_id: first.task.department_id, assignee_names: [...new Set(obligations.map(row => row.assignee.name))], assignee_count: new Set(obligations.map(row => row.assignee.id)).size, submitted_count: obligations.filter(row => !!row.first_submission_id).length, occurrence_count: obligations.length, open_occurrence_id: first.id };
  }), [rows]);
  const taskList = providedTasks?.length ? providedTasks : fallbackTasks;
  const filteredTasks = useMemo(() => taskList.filter(task => (!search || `${task.title} ${task.assignee_names.join(" ")}`.toLowerCase().includes(search.toLowerCase())) && (!scope || task.scope_type === scope) && (!priority || task.priority === priority)).sort((a, b) => sort === "title_asc" ? a.title.localeCompare(b.title) : sort === "title_desc" ? b.title.localeCompare(a.title) : sort === "created_asc" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)), [taskList, search, scope, priority, sort]);
  const people = new Set(taskList.flatMap(task => task.assignee_names));
  return <section aria-label="Task assignment workspace" className="space-y-3">
   <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="size-4" />Assigned tasks</CardTitle></CardHeader><CardContent className="space-y-3">
     <p className="text-sm text-muted-foreground">{taskList.length} task definitions · {people.size} employees. Search and manage tasks across the full authorized assignment scope.</p>
     <div className="flex flex-wrap gap-2"><Input className="min-w-52 flex-1" aria-label="Search created tasks" placeholder="Search tasks or assignees…" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Filter task scope" className={selectClass} value={scope} onChange={event => setScope(event.target.value)}><option value="">All scopes</option><option value="GLOBAL">Global</option><option value="DEPARTMENT">Department</option></select><select aria-label="Filter task priority" className={selectClass} value={priority} onChange={event => setPriority(event.target.value)}><option value="">All priorities</option>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map(value => <option key={value}>{value}</option>)}</select><select aria-label="Sort created tasks" className={selectClass} value={sort} onChange={event => setSort(event.target.value)}><option value="created_desc">Newest first</option><option value="created_asc">Oldest first</option><option value="title_asc">Title A-Z</option><option value="title_desc">Title Z-A</option></select></div>
    <div className="divide-y rounded-lg border">{filteredTasks.map(task => <button key={task.id} type="button" disabled={!task.open_occurrence_id} onClick={() => task.open_occurrence_id && onOpen(task.open_occurrence_id)} className="flex w-full flex-wrap items-center justify-between gap-3 p-3 text-left hover:bg-muted/50 disabled:cursor-default disabled:opacity-60">
      <span><span className="block text-sm font-medium">{task.title}</span><span className="text-xs text-muted-foreground">{task.scope_type} · {task.assignee_count} assignees · {task.submitted_count} submitted · {task.occurrence_count} obligations · {task.priority}</span></span><span className="text-right text-xs text-primary">{task.open_occurrence_id ? "Open task" : "No occurrence"}</span>
     </button>)}{!filteredTasks.length && <p className="p-4 text-sm text-muted-foreground">No created tasks match the selected filters.</p>}</div>
   {availability && !availability.canSave && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p className="font-medium">You can review assignment details; saving is unavailable for your account.</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{availability.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="mt-2 text-xs">Use <strong>Create &amp; Assign Task</strong> to review employee selection, reporting, and recurrence controls.</p></div>}
  </CardContent></Card>
 </section>;
}
