CREATE TABLE ai_chats (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ai_chats_owner ON ai_chats(owner_id, folder_id, updated_at DESC);

-- Each folder (and the root) had one conversation before: it becomes a chat with its messages.
INSERT INTO ai_chats (id, owner_id, folder_id, title, created_at, updated_at)
SELECT lower(hex(randomblob(16))),
       m1.owner_id,
       m1.folder_id,
       COALESCE(NULLIF((
           SELECT substr(m2.content, 1, 80) FROM ai_messages m2
           WHERE m2.owner_id = m1.owner_id AND m2.folder_id IS m1.folder_id AND m2.role = 'user'
           ORDER BY m2.created_at, m2.id LIMIT 1
       ), ''), '新对话'),
       MIN(m1.created_at),
       MAX(m1.created_at)
FROM ai_messages m1
GROUP BY m1.owner_id, m1.folder_id;

ALTER TABLE ai_messages ADD COLUMN chat_id TEXT;

UPDATE ai_messages
SET chat_id = (
    SELECT c.id FROM ai_chats c
    WHERE c.owner_id = ai_messages.owner_id AND c.folder_id IS ai_messages.folder_id
);
