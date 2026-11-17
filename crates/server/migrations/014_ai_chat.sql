CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES folders (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ai_messages_owner ON ai_messages (owner_id, folder_id, created_at);
