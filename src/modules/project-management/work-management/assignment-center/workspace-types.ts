import type { ComponentType } from "react";
import type { Bootstrap, Employee, OccurrenceView, Summary, Task, Workspace } from "./types";

export type WorkApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export interface HeaderAccount { name: string; email: string; avatar: string }
export interface TrendPoint { date: string; due: number; submitted: number; on_time: number }
export interface DashboardData { employees: (Employee & Summary)[]; trends: TrendPoint[] }
export interface WorkspaceActionsProps { bootstrap: Bootstrap | null; onCreate: () => void }
export interface DashboardProps {
 data: DashboardData; selectedEmployee: string;
 periodLabel: string; onSelectEmployee: (id: string) => void; onClearEmployee: () => void;
}
export interface TaskSummary { id: string; title: string; scope_type: "DEPARTMENT" | "GLOBAL"; priority: Task["priority"]; lifecycle_status: Task["lifecycle_status"]; created_at: string; department_id: string | null; assignee_names: string[]; assignee_count: number; submitted_count: number; occurrence_count: number; open_occurrence_id: string | null }
export interface OverviewProps { bootstrap: Bootstrap | null; rows: OccurrenceView[]; tasks?: TaskSummary[]; onCreate: () => void; onOpen: (id: string) => void }
export interface WorkspaceDefinition {
 workspace: Workspace;
 title: string;
 description: string;
 views: readonly string[];
 initialView?: string;
  progressLabel?: string;
  globalAssignment?: boolean;
 Overview?: ComponentType<OverviewProps>;
 Actions?: ComponentType<WorkspaceActionsProps>;
 Dashboard?: ComponentType<DashboardProps>;
 loadDashboard?: (api: WorkApi, query: URLSearchParams) => Promise<DashboardData>;
}
