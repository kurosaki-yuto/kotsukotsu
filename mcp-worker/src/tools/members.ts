// MCP ツール (members)。index.ts の tools から切り出し。
import { z } from "zod";
import { ToolDef, assertAdmin, assertCanManage, assertGoalInScope, uid } from "../lib";

export const membersTools: Record<string, ToolDef> = {
  list_members: {
    description: "List all members in the roster (id, name, email, role).",
    schema: z.object({}),
    handler: async (_args, env, wsId) => {
      const { results } = await env.DB.prepare(
        "SELECT id, name, email, role FROM members WHERE workspace_id = ?"
      ).bind(wsId).all();
      return results;
    },
  },

  assign_member_to_goal: {
    description:
      "Assign a member to a goal (grants access). canEdit defaults to false " +
      "(view-only). No-op if the member is already assigned.",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      memberId: z.string().min(1).describe("Member id"),
      canEdit: z.boolean().optional().describe("true = can edit, defaults to false"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      await assertCanManage(env, wsId, auth, args.goalId);
      // both the goal and the member must live in this workspace
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      const member = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(args.memberId, wsId).first();
      if (!member) throw new Error(`member not found: ${args.memberId}`);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO goal_members (goal_id, member_id, can_edit) VALUES (?, ?, ?)"
      )
        .bind(args.goalId, args.memberId, args.canEdit ? 1 : 0)
        .run();
      return { ok: true };
    },
  },

  unassign_member_from_goal: {
    description: "Remove a member's assignment from a goal (revokes access).",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      memberId: z.string().min(1).describe("Member id"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      await assertCanManage(env, wsId, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      const member = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(args.memberId, wsId).first();
      if (!member) throw new Error(`member not found: ${args.memberId}`);
      await env.DB.prepare(
        "DELETE FROM goal_members WHERE goal_id = ? AND member_id = ?"
      )
        .bind(args.goalId, args.memberId)
        .run();
      return { ok: true };
    },
  },

  set_member_role: {
    description:
      "Promote a member to admin or demote to member. Updates the roster row and, " +
      "if the member has a matching auth account (by email), the real auth permission " +
      "on users.role too.",
    schema: z.object({
      memberId: z.string().min(1).describe("Member id"),
      role: z.enum(["admin", "member"]).describe("admin = full access, member = none"),
    }),
    handler: async (args, env, wsId, auth) => {
      assertAdmin(auth);
      const member = await env.DB.prepare("SELECT email FROM members WHERE id = ? AND workspace_id = ?")
        .bind(args.memberId, wsId)
        .first<{ email: string | null }>();
      const memberRole = args.role === "admin" ? "Admin" : "None";
      const res = await env.DB.prepare("UPDATE members SET role = ? WHERE id = ? AND workspace_id = ?")
        .bind(memberRole, args.memberId, wsId)
        .run();
      if (!res.meta.changes) throw new Error(`member not found: ${args.memberId}`);
      // change the role only WITHIN this workspace (workspace_members), never the
      // user's global identity — so an AI on WS-B can't escalate someone in WS-A.
      if (member?.email) {
        const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(member.email).first<{ id: string }>();
        if (u?.id) {
          await env.DB.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?")
            .bind(args.role, wsId, u.id)
            .run();
        }
      }
      return { ok: true };
    },
  },

  create_invite: {
    description:
      "Create an invite link (token valid 7 days). Optionally pre-bind an email and " +
      "role (defaults to 'member'). Returns the token and a ready-to-share join URL.",
    schema: z.object({
      email: z.string().optional().describe("Pre-bind the invite to an email"),
      role: z.enum(["admin", "member"]).optional().describe("Role granted on accept, defaults to 'member'"),
    }),
    handler: async (args, env, wsId, auth) => {
      assertAdmin(auth);
      const token = uid();
      const role = args.role ?? "member";
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO invites (token, email, role, expires_at, workspace_id) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(token, args.email ?? null, role, expires, wsId)
        .run();
      return {
        token,
        url: (env.PUSH_URL ?? "https://kotukotu.app") + "/login?invite=" + token,
      };
    },
  },
};
