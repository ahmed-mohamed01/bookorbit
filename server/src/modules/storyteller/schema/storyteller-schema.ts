// Storyteller integration schema bootstrap SQL, embedded as a string rather than shipped as a
// .sql asset (same reasoning as the other fork bootstraps: the SWC watch builder does not reliably
// copy assets into dist). Applied on every boot; every statement is idempotent.
//
// Constraint names are deliberately short (`<table>_<column>_fk` rather than repeating the
// referenced table and column): Postgres silently truncates identifiers over 63 bytes, and
// `storyteller_read_along_builds_target_folder_id_library_folders_id_fk`-style names would have
// collided once truncated.
//
// **Every constraint is also added by a guarded ALTER.** `CREATE TABLE IF NOT EXISTS` is a no-op on
// a database whose table already exists, so a constraint that lives only inside it never reaches an
// install created by an earlier iteration of this file - and there are no Drizzle migrations here to
// carry it. The inline copies stay because they are what a fresh database gets in one statement; the
// ALTERs are what bring an existing one to the same shape. Losing the pair unique that way is not
// cosmetic: `startBuild` upserts ON CONFLICT on those two columns, so every build request would die
// at `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`,
// permanently and with no self-heal.
//
// The guards match on `conrelid` as well as `conname` because a constraint name is only unique per
// table, so a bare name check can be satisfied by some other table's constraint - and because it
// makes each statement provable against a scratch table in a throwaway schema.
//
// `delete_remote_after_import` defaults to true (reclaim the Storyteller copy once the read-along
// has been imported). `CREATE TABLE IF NOT EXISTS` cannot carry that to a database installed while
// the default was false, so the guarded ALTER below sets it; it deliberately touches no existing
// row, whose stored value is the operator's own choice.
export const STORYTELLER_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS "storyteller_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"server_url" varchar(2048),
	"username" varchar(255),
	"password_enc" text,
	"path_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_library_id" integer,
	"target_folder_id" integer,
	"transport" varchar(20) DEFAULT 'auto' NOT NULL,
	"delete_remote_after_import" boolean DEFAULT true NOT NULL,
	"collection_name" varchar(255),
	"last_checked_at" timestamp with time zone,
	"last_check_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storyteller_settings_singleton_chk" CHECK ("id" = 1),
	CONSTRAINT "storyteller_settings_transport_chk" CHECK ("transport" in ('auto', 'shared-paths', 'api-transfer'))
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_settings')
			AND conname = 'storyteller_settings_singleton_chk'
	) THEN
		ALTER TABLE "storyteller_settings" ADD CONSTRAINT "storyteller_settings_singleton_chk" CHECK ("id" = 1);
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_settings')
			AND conname = 'storyteller_settings_transport_chk'
	) THEN
		ALTER TABLE "storyteller_settings" ADD CONSTRAINT "storyteller_settings_transport_chk" CHECK ("transport" in ('auto', 'shared-paths', 'api-transfer'));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public'
			AND table_name = 'storyteller_settings'
			AND column_name = 'delete_remote_after_import'
			AND column_default IS DISTINCT FROM 'true'
	) THEN
		ALTER TABLE "storyteller_settings" ALTER COLUMN "delete_remote_after_import" SET DEFAULT true;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_settings')
			AND conname = 'storyteller_settings_target_library_id_fk'
	) THEN
		ALTER TABLE "storyteller_settings" ADD CONSTRAINT "storyteller_settings_target_library_id_fk" FOREIGN KEY ("target_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_settings')
			AND conname = 'storyteller_settings_target_folder_id_fk'
	) THEN
		ALTER TABLE "storyteller_settings" ADD CONSTRAINT "storyteller_settings_target_folder_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storyteller_read_along_builds" (
	"id" serial PRIMARY KEY NOT NULL,
	"text_book_id" integer NOT NULL,
	"audio_book_id" integer NOT NULL,
	"target_library_id" integer,
	"target_folder_id" integer,
	"output_book_id" integer,
	"attached_link_id" integer,
	"storyteller_book_uuid" varchar(64),
	"transport" varchar(20),
	"status" varchar(20) DEFAULT 'building' NOT NULL,
	"phase" varchar(20),
	"remote_task" varchar(255),
	"remote_progress" real,
	"error" text,
	"started_at" timestamp with time zone,
	"built_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storyteller_read_along_builds_pair_unique" UNIQUE("text_book_id", "audio_book_id"),
	CONSTRAINT "storyteller_read_along_builds_status_chk" CHECK ("status" in ('building', 'ready', 'failed', 'cancelled')),
	CONSTRAINT "storyteller_read_along_builds_phase_chk" CHECK ("phase" is null or "phase" in ('prepare', 'register', 'process', 'wait', 'collect', 'link')),
	CONSTRAINT "storyteller_read_along_builds_transport_chk" CHECK ("transport" is null or "transport" in ('shared-paths', 'api-transfer')),
	CONSTRAINT "storyteller_read_along_builds_remote_progress_chk" CHECK ("remote_progress" is null or ("remote_progress" >= 0 and "remote_progress" <= 1))
);
--> statement-breakpoint
ALTER TABLE "storyteller_read_along_builds" ADD COLUMN IF NOT EXISTS "target_folder_id" integer;
--> statement-breakpoint
ALTER TABLE "storyteller_read_along_builds" ADD COLUMN IF NOT EXISTS "attached_link_id" integer;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_pair_unique'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_pair_unique" UNIQUE("text_book_id", "audio_book_id");
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_status_chk'
			AND pg_get_constraintdef(oid) NOT LIKE '%cancelled%'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" DROP CONSTRAINT "storyteller_read_along_builds_status_chk";
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_status_chk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_status_chk" CHECK ("status" in ('building', 'ready', 'failed', 'cancelled'));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_phase_chk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_phase_chk" CHECK ("phase" is null or "phase" in ('prepare', 'register', 'process', 'wait', 'collect', 'link'));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_transport_chk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_transport_chk" CHECK ("transport" is null or "transport" in ('shared-paths', 'api-transfer'));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_remote_progress_chk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_remote_progress_chk" CHECK ("remote_progress" is null or ("remote_progress" >= 0 and "remote_progress" <= 1));
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_text_book_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_text_book_id_fk" FOREIGN KEY ("text_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_audio_book_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_audio_book_id_fk" FOREIGN KEY ("audio_book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_target_library_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_target_library_id_fk" FOREIGN KEY ("target_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_target_folder_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_target_folder_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_output_book_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_output_book_id_fk" FOREIGN KEY ("output_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF to_regclass('book_edition_links') IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = to_regclass('storyteller_read_along_builds')
			AND conname = 'storyteller_read_along_builds_attached_link_id_fk'
	) THEN
		ALTER TABLE "storyteller_read_along_builds" ADD CONSTRAINT "storyteller_read_along_builds_attached_link_id_fk" FOREIGN KEY ("attached_link_id") REFERENCES "public"."book_edition_links"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF to_regclass('book_edition_links') IS NOT NULL THEN
		UPDATE "storyteller_read_along_builds" AS b SET "attached_link_id" = l."id"
		FROM "book_edition_links" AS l
		WHERE b."attached_link_id" IS NULL
			AND b."status" = 'ready'
			AND b."built_at" IS NOT NULL
			AND l."text_book_id" = b."text_book_id"
			AND l."audio_book_id" = b."audio_book_id"
			AND (l."created_at" < b."built_at" OR l."read_along_book_id" = b."output_book_id");
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storyteller_read_along_builds_output_book_id_idx" ON "storyteller_read_along_builds" USING btree ("output_book_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storyteller_read_along_builds_uuid_idx" ON "storyteller_read_along_builds" USING btree ("storyteller_book_uuid");
`;
