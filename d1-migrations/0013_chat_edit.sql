-- Comment edit/delete support. author_email identifies the comment's owner so
-- only that person (or an admin / the workspace AI key) can edit or delete it —
-- author alone is just a display name and can collide or change. edited_at
-- marks a comment as edited so the UI can show 「編集済み」.
ALTER TABLE chat_messages ADD COLUMN author_email TEXT;
ALTER TABLE chat_messages ADD COLUMN edited_at TEXT;
