export const EDITION_LINK_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "book_edition_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"text_book_id" integer,
	"audio_book_id" integer NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_edition_links_text_book_id_unique" UNIQUE("text_book_id"),
	CONSTRAINT "book_edition_links_audio_book_id_unique" UNIQUE("audio_book_id")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'book_edition_links_text_book_id_books_id_fk'
	) THEN
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_text_book_id_books_id_fk" FOREIGN KEY ("text_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'book_edition_links_audio_book_id_books_id_fk'
	) THEN
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_audio_book_id_books_id_fk" FOREIGN KEY ("audio_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
	col_notnull boolean;
	fk_deltype "char";
BEGIN
	-- Guarded bootstrap: only touch created_by when its shape is actually wrong. An unconditional
	-- DROP NOT NULL + DROP/ADD CONSTRAINT every boot takes ACCESS EXCLUSIVE locks and leaves a window
	-- with no FK where concurrent instances can race. We inspect the catalog and alter only on drift.
	SELECT attnotnull INTO col_notnull
	FROM pg_attribute
	WHERE attrelid = 'book_edition_links'::regclass AND attname = 'created_by' AND NOT attisdropped;

	IF col_notnull THEN
		ALTER TABLE "book_edition_links" ALTER COLUMN "created_by" DROP NOT NULL;
	END IF;

	SELECT confdeltype INTO fk_deltype
	FROM pg_constraint
	WHERE conname = 'book_edition_links_created_by_users_id_fk' AND conrelid = 'book_edition_links'::regclass;

	-- confdeltype 'n' = ON DELETE SET NULL. Recreate only when the FK is missing or has a different action.
	IF fk_deltype IS DISTINCT FROM 'n'::"char" THEN
		ALTER TABLE "book_edition_links" DROP CONSTRAINT IF EXISTS "book_edition_links_created_by_users_id_fk";
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_links_text_book_id_unique" ON "book_edition_links" USING btree ("text_book_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_links_audio_book_id_unique" ON "book_edition_links" USING btree ("audio_book_id");
--> statement-breakpoint
ALTER TABLE "book_edition_links" ADD COLUMN IF NOT EXISTS "read_along_book_id" integer;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'book_edition_links_read_along_book_id_books_id_fk' AND conrelid = 'book_edition_links'::regclass
	) THEN
		ALTER TABLE "book_edition_links" ADD CONSTRAINT "book_edition_links_read_along_book_id_books_id_fk" FOREIGN KEY ("read_along_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_links_read_along_book_id_unique" ON "book_edition_links" USING btree ("read_along_book_id") WHERE "read_along_book_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
	col_notnull boolean;
BEGIN
	SELECT attnotnull INTO col_notnull
	FROM pg_attribute
	WHERE attrelid = 'book_edition_links'::regclass AND attname = 'text_book_id' AND NOT attisdropped;

	IF col_notnull THEN
		ALTER TABLE "book_edition_links" ALTER COLUMN "text_book_id" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
	col_notnull boolean;
BEGIN
	SELECT attnotnull INTO col_notnull
	FROM pg_attribute
	WHERE attrelid = 'book_edition_links'::regclass AND attname = 'audio_book_id' AND NOT attisdropped;

	IF col_notnull THEN
		ALTER TABLE "book_edition_links" ALTER COLUMN "audio_book_id" DROP NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_edition_link_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"link_id" integer NOT NULL REFERENCES "public"."book_edition_links"("id") ON DELETE cascade ON UPDATE no action,
	"book_id" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"role" varchar(16) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_edition_link_members_book_id_unique" UNIQUE("book_id"),
	CONSTRAINT "book_edition_link_members_role_chk" CHECK ("role" IN ('text', 'audio', 'readAlong'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "book_edition_link_members_link_id_idx" ON "book_edition_link_members" USING btree ("link_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "book_edition_link_members_primary_unique" ON "book_edition_link_members" USING btree ("link_id","role") WHERE "is_primary";
--> statement-breakpoint
DELETE FROM "book_edition_links" link
WHERE link."text_book_id" IS NULL
	AND link."read_along_book_id" IS NULL
	AND (SELECT count(*) FROM "book_edition_link_members" member WHERE member."link_id" = link."id") < 2;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bookorbit_edition_link_claim_primary"(p_link_id integer, p_book_id integer, p_role varchar) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
	owner_link integer;
BEGIN
	IF p_book_id IS NULL THEN
		RETURN;
	END IF;
	SELECT "link_id" INTO owner_link FROM "book_edition_link_members" WHERE "book_id" = p_book_id;
	IF owner_link IS NOT NULL AND owner_link <> p_link_id THEN
		RAISE EXCEPTION 'book % already belongs to edition link %', p_book_id, owner_link USING ERRCODE = 'unique_violation';
	END IF;
	UPDATE "book_edition_link_members" SET "is_primary" = false
	WHERE "link_id" = p_link_id AND "role" = p_role AND "is_primary" AND "book_id" <> p_book_id;
	INSERT INTO "book_edition_link_members" ("link_id", "book_id", "role", "is_primary")
	VALUES (p_link_id, p_book_id, p_role, true)
	ON CONFLICT ("book_id") DO UPDATE SET "role" = EXCLUDED."role", "is_primary" = true;
END $fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bookorbit_edition_link_sync_members"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
	-- Slots always name the primary member of their role. A slot that moves off a book drops that book
	-- while it is still the primary; a book demoted first (a primary swap) stays as a duplicate.
	IF TG_OP = 'UPDATE' THEN
		IF OLD."text_book_id" IS NOT NULL AND OLD."text_book_id" IS DISTINCT FROM NEW."text_book_id" THEN
			DELETE FROM "book_edition_link_members" WHERE "link_id" = NEW."id" AND "book_id" = OLD."text_book_id" AND "is_primary";
		END IF;
		IF OLD."audio_book_id" IS NOT NULL AND OLD."audio_book_id" IS DISTINCT FROM NEW."audio_book_id" THEN
			DELETE FROM "book_edition_link_members" WHERE "link_id" = NEW."id" AND "book_id" = OLD."audio_book_id" AND "is_primary";
		END IF;
		IF OLD."read_along_book_id" IS NOT NULL AND OLD."read_along_book_id" IS DISTINCT FROM NEW."read_along_book_id" THEN
			DELETE FROM "book_edition_link_members" WHERE "link_id" = NEW."id" AND "book_id" = OLD."read_along_book_id" AND "is_primary";
		END IF;
	END IF;
	PERFORM "bookorbit_edition_link_claim_primary"(NEW."id", NEW."text_book_id", 'text');
	PERFORM "bookorbit_edition_link_claim_primary"(NEW."id", NEW."audio_book_id", 'audio');
	PERFORM "bookorbit_edition_link_claim_primary"(NEW."id", NEW."read_along_book_id", 'readAlong');
	RETURN NULL;
END $fn$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "book_edition_links_sync_members"
AFTER INSERT OR UPDATE OF "text_book_id", "audio_book_id", "read_along_book_id" ON "book_edition_links"
FOR EACH ROW EXECUTE FUNCTION "bookorbit_edition_link_sync_members"();
--> statement-breakpoint
INSERT INTO "book_edition_link_members" ("link_id", "book_id", "role", "is_primary")
SELECT link."id", slot.book_id, slot.role, true
FROM "book_edition_links" link
CROSS JOIN LATERAL (
	VALUES (link."text_book_id", 'text'), (link."audio_book_id", 'audio'), (link."read_along_book_id", 'readAlong')
) AS slot(book_id, role)
WHERE slot.book_id IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "book_edition_link_members" member WHERE member."book_id" = slot.book_id)
	AND NOT EXISTS (SELECT 1 FROM "book_edition_link_members" member WHERE member."link_id" = link."id" AND member."role" = slot.role AND member."is_primary")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_link_user_settings" (
	"user_id" integer PRIMARY KEY NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"enabled" boolean DEFAULT true NOT NULL,
	"share_reading_state" boolean DEFAULT true NOT NULL,
	"same_type_as_one_work" boolean DEFAULT true NOT NULL,
	"position_sync" varchar(10) DEFAULT 'rough' NOT NULL,
	"auto_link_strong" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_link_user_settings_position_sync_chk" CHECK ("position_sync" IN ('off', 'precise', 'rough'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_link_match_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"library_id" integer,
	"state" varchar(16) DEFAULT 'running' NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"auto_linked" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "edition_link_match_scans_state_chk" CHECK ("state" IN ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_link_match_scans_user_started_idx" ON "edition_link_match_scans" USING btree ("user_id", "started_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_link_match_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_id" integer NOT NULL REFERENCES "public"."edition_link_match_scans"("id") ON DELETE cascade ON UPDATE no action,
	"user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"source_book_id" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"target_book_id" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"target_role" varchar(16) NOT NULL,
	"bucket" varchar(20) NOT NULL,
	"score" real NOT NULL,
	"title_score" real NOT NULL,
	"author_score" real NOT NULL,
	"isbn_match" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"link_id" integer,
	"competing_book_ids" integer[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_link_match_results_target_role_chk" CHECK ("target_role" IN ('text', 'audio', 'readAlong', 'duplicate')),
	CONSTRAINT "edition_link_match_results_bucket_chk" CHECK ("bucket" IN ('linked_ok', 'linked_suspect', 'conflict', 'strong', 'weak'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_link_match_results_scan_bucket_idx" ON "edition_link_match_results" USING btree ("scan_id", "bucket");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edition_link_match_results_user_idx" ON "edition_link_match_results" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edition_link_match_dismissals" (
	"user_id" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	"book_id_a" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"book_id_b" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edition_link_match_dismissals_pk" PRIMARY KEY("user_id", "book_id_a", "book_id_b"),
	CONSTRAINT "edition_link_match_dismissals_order_chk" CHECK ("book_id_a" < "book_id_b")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_along_narration_offsets" (
	"id" serial PRIMARY KEY NOT NULL,
	"read_along_file_id" integer NOT NULL REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action,
	"audio_book_id" integer NOT NULL REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action,
	"narration_signature" jsonb NOT NULL,
	"audio_signature" jsonb NOT NULL,
	"status" varchar(20) NOT NULL,
	"source" varchar(20) NOT NULL,
	"offsets" jsonb,
	"mismatch" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "read_along_narration_offsets_file_audio_unique" ON "read_along_narration_offsets" USING btree ("read_along_file_id","audio_book_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_along_narration_offsets_audio_book_id_idx" ON "read_along_narration_offsets" USING btree ("audio_book_id");
`;
