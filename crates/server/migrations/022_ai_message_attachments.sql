-- Files the user attached to a chat message (docs/ai.md#附件): their metadata, by attachment id,
-- kept with the message for showing them in the conversation. A turn that changes the folder also
-- attaches them to the tidying job it creates, which is how the model sees the pictures.
ALTER TABLE ai_messages ADD COLUMN attachments TEXT;
