-- Every workspace gets an owner: its earliest admin, or failing that its earliest member.
UPDATE "workspace_members" wm SET "role" = 'owner'
FROM (
  SELECT DISTINCT ON ("workspace_id") "workspace_id", "user_id"
  FROM "workspace_members"
  ORDER BY "workspace_id", ("role" = 'admin') DESC, "joined_at" ASC, "user_id" ASC
) first_admin
WHERE wm."workspace_id" = first_admin."workspace_id"
  AND wm."user_id" = first_admin."user_id"
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_members" o WHERE o."workspace_id" = wm."workspace_id" AND o."role" = 'owner'
  );
