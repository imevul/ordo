-- Bots of live integrations: their integration's workspace.
UPDATE "users" u SET "bot_workspace_id" = i."workspace_id"
FROM "integrations" i
WHERE i."bot_user_id" = u."id" AND u."kind" = 'bot' AND u."bot_workspace_id" IS NULL;
--> statement-breakpoint
-- Bots whose integration is already gone: wherever they left a trace (events, issue history).
UPDATE "users" u SET "bot_workspace_id" = (
  SELECT e."workspace_id" FROM "domain_events" e WHERE e."actor_id" = u."id" LIMIT 1
)
WHERE u."kind" = 'bot' AND u."bot_workspace_id" IS NULL;
--> statement-breakpoint
UPDATE "users" u SET "bot_workspace_id" = (
  SELECT i."workspace_id" FROM "issue_history" h JOIN "issues" i ON i."id" = h."issue_id"
  WHERE h."actor_id" = u."id" LIMIT 1
)
WHERE u."kind" = 'bot' AND u."bot_workspace_id" IS NULL;
--> statement-breakpoint
-- A bot without an integration is a removed one.
UPDATE "users" u SET "disabled_at" = now()
WHERE u."kind" = 'bot' AND u."disabled_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "integrations" i WHERE i."bot_user_id" = u."id");
