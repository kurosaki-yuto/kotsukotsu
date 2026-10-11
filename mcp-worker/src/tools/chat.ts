// MCP ツール (chat)。index.ts の tools から切り出し。
import { z } from "zod";
import { resolveMentionedMembers } from "../../../app/lib/server/mentions";
import { ToolDef, assertGoalInScope, assertOwnMessage, goalWatcherEmails, notifyPush, nowIso, recordRecipients, uid } from "../lib";

export const chatTools: Record<string, ToolDef> = {
  // ---- chat (goal thread comments, attributed to the human behind the token) ----
  send_chat: {
    description:
      "Post a comment to a goal's thread. The comment is attributed to the human this " +
      "session's token belongs to (the member whose AI is acting) — never to an AI persona. " +
      "メンションの書き方: 本文に「@表示名」を含めるとその人に通知が飛ぶ (例: @山田太郎 確認お願いします)。" +
      "表示名は list_members の name をそのまま使う (名前内のスペースは省略してもよい)。「@全員」で全メンバーに通知。" +
      "結果の notified 配列で誰に通知が飛んだかを確認できる — メンションしたのに notified が空なら表示名が間違っている。",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id"),
      body: z.string().min(1).describe("Message body. Mention with @表示名 (from list_members) or @全員 to notify people."),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      // the goal must belong to this workspace before posting to its thread
      const goal = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?").bind(args.goalId, wsId).first<{ id: string; name: string | null }>();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);
      // A workspace-wide key has no specific human behind it — attributing it
      // to "the workspace's first admin" silently mislabeled every shared-key
      // AI action as that admin personally. Be honest instead: whoever wants
      // their own name on their AI's posts needs their own per-member key
      // (設定 > APIキー).
      const author = auth.actor?.name ?? "AI(共有ワークスペーストークン経由)";
      const authorEmail = auth.actor?.email?.toLowerCase().trim() ?? null;
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO chat_messages (id, goal_id, scope, role, author, author_email, body, created_at, workspace_id) VALUES (?, ?, 'goal', 'user', ?, ?, ?, ?, ?)"
      )
        .bind(id, args.goalId, author, authorEmail, args.body, nowIso(), wsId)
        .run();
      // @name mentions -> notify only the mentioned person (mirrors the app's
      // queries.ts sendMessage — comments no longer broadcast to everyone with
      // goal access, longest name first so a shorter name can't shadow-match).
      // Resolves against every workspace member, not just the goal's assignees,
      // so mentioning someone who isn't assigned still notifies them. Names are
      // also matched with their spaces stripped ("山田　太郎" hits on @山田太郎).
      const { results: members } = await env.DB.prepare(
        `SELECT id, name, email FROM members WHERE workspace_id = ?`
      ).bind(wsId).all<{ id: string; name: string | null; email: string | null }>();
      const mentioned = resolveMentionedMembers(
        args.body,
        (members ?? []).map((m) => ({ id: m.id, name: m.name ?? "", email: m.email }))
      );
      const notifiedEmails = new Set<string>();
      const notifiedNames: string[] = [];
      for (const m of mentioned) {
        const email = m.email?.toLowerCase().trim();
        if (!email || notifiedEmails.has(email)) continue;
        notifiedEmails.add(email);
        notifiedNames.push(m.name);
        const notifId = uid();
        await env.DB.prepare(
          "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'mention', ?, ?, ?, ?, ?, ?)"
        )
          .bind(notifId, `${author}さんからメンション`, `「${goal.name ?? "タスク"}」: ${args.body}`, args.goalId, nowIso(), wsId, email)
          .run();
        await recordRecipients(env, notifId, wsId, args.goalId, email);
      }
      // Wake exactly the mentioned people's phones (the dispatcher's generic
      // goal-assignee push is skipped for send_chat — see PUSH_TOOLS).
      if (notifiedEmails.size) {
        await notifyPush(env, wsId, null, [...notifiedEmails], {
          title: `${author}さんからメンション`,
          body: `「${goal.name ?? "タスク"}」: ${args.body}`,
          url: `/goals/${args.goalId}`,
        });
      }
      // メンションが無いコメントも、担当している人 (そのタスク + 上位ゴール) には
      // 届かせる (2026-09-09 黒崎指示)。1人ずつ target_email 付きで出すので、
      // 関係ない人には出ない。投稿者自身は鳴らさない。
      const watcherEmails = (await goalWatcherEmails(env, wsId, args.goalId)).filter(
        (e) => !notifiedEmails.has(e) && e !== authorEmail
      );
      for (const email of watcherEmails) {
        const notifId = uid();
        await env.DB.prepare(
          "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id, target_email) VALUES (?, 'info', ?, ?, ?, ?, ?, ?)"
        )
          .bind(notifId, `${author}さんがコメント`, `「${goal.name ?? "タスク"}」: ${args.body}`, args.goalId, nowIso(), wsId, email)
          .run();
        await recordRecipients(env, notifId, wsId, args.goalId, email);
      }
      if (watcherEmails.length) {
        await notifyPush(env, wsId, null, watcherEmails, {
          title: `${author}さんがコメント`,
          body: `「${goal.name ?? "タスク"}」: ${args.body}`,
          url: `/goals/${args.goalId}`,
        });
      }
      const row = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(id).first();
      return { ...(row ?? { id }), notified: notifiedNames };
    },
  },

  edit_chat: {
    description:
      "Edit a comment you previously posted (by chat message id from list_comments). " +
      "Member tokens can only edit their own comments; the workspace key can edit " +
      "comments it posted (author 'AI(共有ワークスペーストークン経由)').",
    schema: z.object({
      messageId: z.string().min(1).describe("Chat message id"),
      body: z.string().min(1).describe("New message body"),
    }),
    handler: async (args, env, wsId, auth) => {
      const msg = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?").bind(args.messageId, wsId).first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null }>();
      if (!msg) throw new Error(`message not found: ${args.messageId}`);
      if (msg.goal_id) await assertGoalInScope(env, auth, msg.goal_id);
      assertOwnMessage(auth, msg);
      await env.DB.prepare("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?").bind(args.body, nowIso(), args.messageId).run();
      return env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?").bind(args.messageId).first();
    },
  },

  delete_chat: {
    description:
      "Delete (取り消し) a comment you previously posted (by chat message id from " +
      "list_comments). Member tokens can only delete their own comments; the workspace " +
      "key can delete comments it posted.",
    schema: z.object({
      messageId: z.string().min(1).describe("Chat message id"),
    }),
    handler: async (args, env, wsId, auth) => {
      const msg = await env.DB.prepare("SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ?").bind(args.messageId, wsId).first<{ id: string; goal_id: string | null; author: string | null; author_email: string | null }>();
      if (!msg) throw new Error(`message not found: ${args.messageId}`);
      if (msg.goal_id) await assertGoalInScope(env, auth, msg.goal_id);
      assertOwnMessage(auth, msg);
      await env.DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(args.messageId).run();
      return { ok: true, deleted: args.messageId };
    },
  },

  list_comments: {
    description:
      "List comments (chat messages) posted on a goal's thread, oldest first. " +
      "Team members leave feedback/instructions via comments — read this before " +
      "acting on a goal to see what they've actually asked for.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        "SELECT id, goal_id, role, author, body, created_at FROM chat_messages WHERE goal_id = ? AND workspace_id = ? ORDER BY created_at ASC"
      ).bind(args.goalId, wsId).all();
      return results;
    },
  },

  // ---- resources ----
  list_resources: {
    description: "List resources attached to a goal, newest first.",
    schema: z.object({ goalId: z.string().min(1).describe("Goal (project) id") }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      const { results } = await env.DB.prepare(
        "SELECT * FROM resources WHERE goal_id = ? AND workspace_id = ? ORDER BY updated_at DESC"
      )
        .bind(args.goalId, wsId)
        .all();
      return results;
    },
  },
};
