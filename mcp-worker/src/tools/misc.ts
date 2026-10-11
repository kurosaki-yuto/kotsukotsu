// MCP ツール (misc)。index.ts の tools から切り出し。
import { z } from "zod";
import { safeContentType } from "../../../app/lib/server/filesCore";
import { MAX_FILE_BYTES, SUBTREE_CTE, ToolDef, assertCanEdit, assertGoalInScope, decodeBase64, nowIso, reachableWorkspaces, recordRecipients, safeFileName, uid } from "../lib";

export const miscTools: Record<string, ToolDef> = {
  upload_file: {
    description:
      "Attach a file to a goal's resources (stored in R2, same as the app's file upload). " +
      "Also posts a chat message so it shows up in the goal's thread. One file per call — " +
      "call this once per file when sending multiple files. Max 25MB per file. Every file " +
      "must ship with a caption explaining what it is — a bare file with no explanation is " +
      "not useful to whoever opens the goal later.",
    schema: z.object({
      goalId: z.string().min(1).describe("Goal (project) id to attach the file to"),
      filename: z.string().min(1).describe("Original file name, e.g. 見積書.pdf"),
      contentBase64: z.string().min(1).describe("Base64-encoded file bytes"),
      mimeType: z.string().optional().describe("MIME type, e.g. application/pdf"),
      caption: z.string().min(1).describe("Required: what this file is, shown next to it in the goal's resources (e.g. \"最新の見積書、税込\")"),
    }),
    handler: async (args, env, wsId, auth) => {
      await assertGoalInScope(env, auth, args.goalId);
      await assertCanEdit(env, wsId, auth, args.goalId);
      const goal = await env.DB.prepare("SELECT id, name FROM projects WHERE id = ? AND workspace_id = ?")
        .bind(args.goalId, wsId).first<{ id: string; name: string | null }>();
      if (!goal) throw new Error(`goal not found: ${args.goalId}`);

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(args.contentBase64);
      } catch {
        throw new Error("invalid contentBase64: not valid base64");
      }
      if (bytes.byteLength === 0) throw new Error("empty file");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("ファイルが大きすぎます (25MBまで)");

      if (!env.FILES) throw new Error("ファイル置き場 (R2) が設定されていません");
      const key = `${wsId}/${args.goalId}/${uid()}-${safeFileName(args.filename)}`;
      // 画像・PDF 以外は octet-stream で保存する (text/html や SVG を上げて本体オリジンでスクリプトを動かせないように)
      await env.FILES.put(key, bytes, {
        httpMetadata: { contentType: safeContentType(args.mimeType) },
      });

      const resourceId = uid();
      await env.DB.prepare(
        "INSERT INTO resources (id, goal_id, name, kind, content, url, workspace_id) VALUES (?,?,?,?,?,?,?)"
      )
        .bind(resourceId, args.goalId, args.filename.trim() || "無題", "file", args.caption?.trim() || null, `r2:${key}`, wsId)
        .run();

      // post to the goal's chat thread so it "pops in", same author-resolution as send_chat
      const author = auth.actor?.name ?? "AI(共有ワークスペーストークン経由)";
      const chatBody = `ファイルを追加しました: ${args.filename}`;
      await env.DB.prepare(
        "INSERT INTO chat_messages (id, goal_id, scope, role, author, body, created_at, workspace_id) VALUES (?, ?, 'goal', 'user', ?, ?, ?, ?)"
      )
        .bind(uid(), args.goalId, author, chatBody, nowIso(), wsId)
        .run();
      const fileNotifId = uid();
      await env.DB.prepare(
        "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, 'info', ?, ?, ?, ?, ?)"
      )
        .bind(fileNotifId, "ファイルが追加されました", `「${goal.name ?? "タスク"}」: ${args.filename}`, args.goalId, nowIso(), wsId)
        .run();
      await recordRecipients(env, fileNotifId, wsId, args.goalId);

      return env.DB.prepare("SELECT * FROM resources WHERE id = ?").bind(resourceId).first();
    },
  },

  // ---- notifications ----
  create_notification: {
    description:
      "Create a notification shown in the app. kind defaults to 'info'. " +
      "Optionally tie it to a goal via goalId.",
    schema: z.object({
      title: z.string().min(1).describe("Notification title"),
      body: z.string().optional().describe("Notification body"),
      kind: z.string().optional().describe("e.g. info / warning / success"),
      goalId: z.string().optional().describe("Related goal (project) id"),
    }),
    handler: async (args, env, wsId, auth) => {
      // scoped sessions pin their notifications to a scope subtree
      const goalId: string | null =
        args.goalId ?? (auth.scopeRoots && auth.scopeRoots.length === 1 ? auth.scopeRoots[0] : null);
      if (auth.scopeRoots && !goalId) {
        throw new Error("goalId is required: 複数のゴールにアサインされているため、どのゴール宛の通知か goalId で指定してください");
      }
      // if tied to a goal, that goal must be in this workspace (and in scope)
      if (goalId) {
        await assertGoalInScope(env, auth, goalId);
        await assertCanEdit(env, wsId, auth, goalId);
        const goal = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(goalId, wsId).first();
        if (!goal) throw new Error(`goal not found: ${goalId}`);
      }
      const id = uid();
      await env.DB.prepare(
        "INSERT INTO notifications (id, kind, title, body, goal_id, created_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, args.kind ?? "info", args.title, args.body ?? null, goalId, nowIso(), wsId)
        .run();
      await recordRecipients(env, id, wsId, goalId);
      return env.DB.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first();
    },
  },

  list_notifications: {
    description:
      "List notifications, most recent first (default 20, max 100). Filter by goalId and/or unreadOnly.",
    schema: z.object({
      goalId: z.string().optional().describe("Only notifications tied to this goal"),
      unreadOnly: z.boolean().optional().describe("true = only unread (read_at IS NULL)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max rows, default 20"),
    }),
    handler: async (args, env, wsId, auth) => {
      const limit = args.limit ?? 20;
      const unreadClause = args.unreadOnly ? " AND read_at IS NULL" : "";

      if (args.goalId) {
        await assertGoalInScope(env, auth, args.goalId);
        const { results } = await env.DB.prepare(
          `SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
           WHERE workspace_id = ? AND goal_id = ?${unreadClause} ORDER BY created_at DESC LIMIT ?`
        ).bind(wsId, args.goalId, limit).all();
        return results;
      }

      if (auth.scopeRoots) {
        const { results } = await env.DB.prepare(
          `${SUBTREE_CTE}
           SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
           WHERE workspace_id = ? AND goal_id IN (SELECT id FROM sub)${unreadClause} ORDER BY created_at DESC LIMIT ?`
        ).bind(wsId, JSON.stringify(auth.scopeRoots), wsId, limit).all();
        return results;
      }

      const { results } = await env.DB.prepare(
        `SELECT id, kind, title, body, goal_id, read_at, created_at FROM notifications
         WHERE workspace_id = ?${unreadClause} ORDER BY created_at DESC LIMIT ?`
      ).bind(wsId, limit).all();
      return results;
    },
  },

  // ---- workspaces ----
  list_workspaces: {
    description:
      "この接続で扱えるワークスペースの一覧 (id・名前・役割・既定かどうか)。接続している本人が所属するワークスペースが全部出る。" +
      "既定 (default=true) 以外を触るときは、他のツールに workspace (id か名前) を渡す。",
    schema: z.object({}),
    handler: async (_args, env, _wsId, auth) => {
      const list = await reachableWorkspaces(env, auth);
      return list.map((w) => ({ ...w, default: w.id === auth.wsId }));
    },
  },

};
