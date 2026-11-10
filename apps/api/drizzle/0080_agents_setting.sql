-- Agents became a workspace setting that is off by default. A workspace that already has an agent
-- chose the feature long ago, so it keeps it.
UPDATE "workspaces" SET "settings" = "settings" || '{"agents": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "agents" WHERE "agents"."workspace_id" = "workspaces"."id");
