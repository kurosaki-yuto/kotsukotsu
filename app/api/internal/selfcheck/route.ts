import "server-only";
import { platformEnv } from "@/app/lib/server/platform";
import { json, all } from "../../../lib/server/db";
import { requireWorkspace } from "../../../lib/server/workspace";
import {
  listGoals,
  listGoalMembersBatch,
  listNotifications,
  memberRelevantGoalIds,
} from "../../../lib/server/queries";

/** Constant-time-ish string compare to avoid trivial timing leaks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Every serious bug this app has shipped had the same shape: a query quietly
// stopped returning rows (D1 bound-parameter cap, a hard LIMIT, a visibility
// rule recomputed from mutable state) and the UI rendered the empty result as
// if it were the truth. Nobody noticed until a member said "I can't see my
// stuff". This endpoint runs the real production code paths against real data
// and reports anything that looks like that failure mode, so the next one gets
// caught by a cron instead of by a person.
//
// Deliberately calls the same exported functions the pages call — a
// reimplementation here would keep passing while the real path broke.
type Problem = { workspace: string; check: string; detail: string };

// Same report, reachable by a signed-in admin so it can be run by hand while
// investigating ("is it empty, or is it broken?") instead of only by the cron.
export async function GET(req: Request) {
  const ctx = await requireWorkspace(req);
  if (!ctx) return json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "admin") return json({ error: "forbidden" }, { status: 403 });
  return json(await runChecks(ctx.workspaceId));
}

export async function POST(req: Request) {
  const env = platformEnv() as unknown as { PUSH_SECRET?: string };
  const secret = env.PUSH_SECRET;
  if (!secret) return json({ error: "not configured" }, { status: 501 });
  if (!safeEqual(req.headers.get("x-push-secret") ?? "", secret)) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { workspaceId?: string };
  return json(await runChecks(body.workspaceId));
}

async function runChecks(workspaceId?: string) {
  const workspaces = workspaceId
    ? await all<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE id = ?", workspaceId)
    : await all<{ id: string; name: string }>("SELECT id, name FROM workspaces");

  const problems: Problem[] = [];
  const checked: string[] = [];

  for (const ws of workspaces) {
    const label = ws.name || ws.id;
    checked.push(label);

    // 1. the goal tree itself still loads
    const goalRows = await all<{ c: number }>(
      "SELECT COUNT(*) AS c FROM projects WHERE workspace_id = ? AND status != 'archived'", ws.id
    );
    const expectedGoals = goalRows[0]?.c ?? 0;
    let goals: { id: string }[] = [];
    try {
      goals = (await listGoals(ws.id)) as { id: string }[];
    } catch (e) {
      problems.push({ workspace: label, check: "listGoals", detail: msg(e) });
    }
    if (expectedGoals > 0 && goals.length === 0) {
      problems.push({ workspace: label, check: "listGoals", detail: `${expectedGoals}件あるはずのゴールが0件で返っている` });
    }

    // 2. assignee avatars for EVERY goal at once — this is the exact call that
    //    blew the bound-parameter cap at ~500 goals and blanked every avatar
    if (goals.length) {
      const assignRows = await all<{ c: number }>(
        `SELECT COUNT(*) AS c FROM goal_members gm JOIN projects p ON p.id = gm.goal_id
          WHERE p.workspace_id = ? AND p.status != 'archived'`, ws.id
      );
      const expectedAssigns = assignRows[0]?.c ?? 0;
      try {
        const byGoal = await listGoalMembersBatch(goals.map((g) => g.id), ws.id);
        const got = Object.values(byGoal).reduce((n, xs) => n + xs.length, 0);
        if (expectedAssigns > 0 && got === 0) {
          problems.push({ workspace: label, check: "listGoalMembersBatch", detail: `アサイン${expectedAssigns}件あるのに担当者が1件も返らない` });
        }
      } catch (e) {
        problems.push({ workspace: label, check: "listGoalMembersBatch", detail: msg(e) });
      }
    }

    // 3. per member: someone with assignments must be able to see them, and
    //    must be able to load their notification list
    const members = await all<{ name: string; email: string | null; assigns: number }>(
      `SELECT m.name, m.email, (SELECT COUNT(*) FROM goal_members gm WHERE gm.member_id = m.id) AS assigns
         FROM members m WHERE m.workspace_id = ?`, ws.id
    );
    for (const m of members) {
      if (!m.email || m.assigns === 0) continue;
      try {
        const ids = await memberRelevantGoalIds(m.email, ws.id);
        if (!ids || ids.length === 0) {
          problems.push({ workspace: label, check: "可視ゴール", detail: `${m.name}: ${m.assigns}件アサインされているのに見えるゴールが0` });
        }
      } catch (e) {
        problems.push({ workspace: label, check: "可視ゴール", detail: `${m.name}: ${msg(e)}` });
      }
      try {
        await listNotifications("all", ws.id, { email: m.email, admin: false });
      } catch (e) {
        problems.push({ workspace: label, check: "通知一覧", detail: `${m.name}: ${msg(e)}` });
      }
    }
  }

  return { ok: problems.length === 0, checked, problems };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
