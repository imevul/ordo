-- Invites are looked up by the SHA-256 of their token from now on (hex, like API keys). Encrypting the
-- token for the admin UI needs ORDO_SECRET_KEY, so runMigrations does that in code before the plain
-- column is dropped.
UPDATE "invites" SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex') WHERE "token_hash" IS NULL;
