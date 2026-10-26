-- Existing instances: the earliest account becomes the instance admin, matching what sign-up
-- now does for the first user. No-op when an instance admin already exists.
UPDATE "users" SET "is_instance_admin" = true
WHERE "id" = (SELECT "id" FROM "users" WHERE "kind" = 'human' ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "is_instance_admin");
