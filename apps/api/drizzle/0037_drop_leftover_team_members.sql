-- Removing someone from a workspace used to leave them on its teams. Take them off.
DELETE FROM "team_members" AS tm
USING "teams" AS t
WHERE t."id" = tm."team_id"
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_members" AS wm
    WHERE wm."workspace_id" = t."workspace_id" AND wm."user_id" = tm."user_id"
  );
