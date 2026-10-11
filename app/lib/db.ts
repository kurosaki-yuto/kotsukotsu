"use client";

// 型は画面とサーバーで共有する。DB の行の形は server 側 (queries.ts) が正。

// projects == goals
export type Project = {
  id: string;
  name: string;
  order_idx: number;
  created_at: string;
  emoji: string | null;
  deadline: string | null;          // date
  current_state: string | null;
  completion_criteria: string | null;
  owner: string | null;
  status: string;                   // active / done / archived
  archived_at: string | null;
  parent_goal_id: string | null;
  created_by: string | null;
  // 進行中: status = active かつ started_at あり。誰が始めたかは開始時点の名前
  started_at?: string | null;
  started_by_name?: string | null;
  started_via?: string | null;      // 'app' = 画面のボタン / それ以外 = AI の名前
  template_id?: string | null;      // 型 (テンプレート) から作られたゴール
};
export type Goal = Project;

// 型 (テンプレート): 必要な入力値 + 資料リンク + タスクの木。/templates。中身の型は templateCore.ts が正
export type { TemplateInput, TemplateTask, TemplateResource } from "./server/templateCore";
import type { TemplateInput, TemplateTask, TemplateResource } from "./server/templateCore";
export type Template = {
  id: string;
  workspace_id: string;
  name: string;
  purpose: string | null;
  completion_criteria: string | null;
  inputs: TemplateInput[];
  tasks: TemplateTask[];
  resources: TemplateResource[];
  source_goal_id: string | null;
  created_by: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};
export type TemplateSummary = Template & { task_count: number; used_count: number };

export type DbNode = {
  id: string;
  project_id: string;
  parent_id: string | null;
  text: string;
  order_idx: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  today_date: string | null;        // selected as 今日のToDo for this date
  estimate_min: number | null;
  due_at: string | null;            // ISO datetime; reminder fires once at/after this
  reminded_at: string | null;       // set once the due reminder notification has fired
};

export type Member = {
  id: string;
  name: string;
  role: string;          // Admin / None
  is_ai: boolean;
  is_you: boolean;
  email: string | null;
  avatar: string | null;
  points: number;
  streak: number;
  joined_at: string;
};

export type AppNotification = {
  id: string;
  kind: string;          // info / mention / goal / streak / addy
  title: string;
  body: string | null;
  goal_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type ChatMessage = {
  id: string;
  goal_id: string | null;
  scope: string;         // goal / today
  role: string;          // user / addy / system
  author: string | null;
  author_email: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
};

export type Resource = {
  id: string;
  goal_id: string | null;
  name: string;
  kind: string;          // note / file / link / doc
  url: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
};

export type OrgSettings = {
  id: number;
  name: string;
  timezone: string;
  logo_url: string | null;
  updated_at: string;
};

export type DoneEntry = {
  id: string;
  project_id: string | null;
  project_name: string | null;
  text: string;
  sub_md: string | null;
  completed_at: string;
};

export type TreeNode = DbNode & { children: TreeNode[] };
