CREATE TABLE "author_catalog_source_works" (
	"work_id" varchar(255) NOT NULL,
	"source" varchar(20) NOT NULL,
	"provider_work_id" varchar(255) NOT NULL,
	CONSTRAINT "author_catalog_source_works_work_id_source_pk" PRIMARY KEY("work_id","source")
);
--> statement-breakpoint
CREATE TABLE "author_catalog_state" (
	"monitor_author_id" varchar(36) PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "author_catalog_works" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"title" varchar(1000) NOT NULL,
	"subtitle" varchar(1000),
	"series_name" varchar(500),
	"series_index" varchar(50),
	"series_memberships" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"release_year" integer,
	"ebook_release_date" varchar(10),
	"ebook_date_precision" varchar(5),
	"audio_release_date" varchar(10),
	"audio_date_precision" varchar(5),
	"cover_url" text,
	"description" text,
	"verdict" varchar(10) NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_book_id" integer,
	"matched_ebook_book_id" integer,
	"matched_audio_book_id" integer,
	"owned_formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "author_catalog_works_verdict_chk" CHECK ("author_catalog_works"."verdict" in ('verified', 'probable', 'suspect'))
);
--> statement-breakpoint
CREATE TABLE "author_provider_identities" (
	"monitor_author_id" varchar(36) NOT NULL,
	"source" varchar(20) NOT NULL,
	"provider_id" varchar(255) NOT NULL,
	CONSTRAINT "author_provider_identities_monitor_author_id_source_pk" PRIMARY KEY("monitor_author_id","source")
);
--> statement-breakpoint
CREATE TABLE "monitored_author_works" (
	"work_id" varchar(255) PRIMARY KEY NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"monitor_state" varchar(12) DEFAULT 'monitoring' NOT NULL,
	"monitor_ebook" boolean,
	"monitor_audiobook" boolean,
	"user_visibility" varchar(10),
	"ebook_request_id" integer,
	"audiobook_request_id" integer,
	CONSTRAINT "monitored_author_works_monitor_state_chk" CHECK ("monitored_author_works"."monitor_state" in ('monitoring', 'paused', 'stopped')),
	CONSTRAINT "monitored_author_works_user_visibility_chk" CHECK ("monitored_author_works"."user_visibility" is null or "monitored_author_works"."user_visibility" in ('hidden', 'visible'))
);
--> statement-breakpoint
CREATE TABLE "monitored_authors" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"author_name" varchar(500) NOT NULL,
	"local_author_id" integer,
	"paused" boolean DEFAULT false NOT NULL,
	"ebook_mode" varchar(20) NOT NULL,
	"ebook_library_id" integer,
	"ebook_folder_id" integer,
	"audiobook_mode" varchar(20) NOT NULL,
	"audiobook_library_id" integer,
	"audiobook_folder_id" integer,
	"added_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	CONSTRAINT "monitored_authors_ebook_mode_chk" CHECK ("monitored_authors"."ebook_mode" in ('notify', 'auto-upcoming', 'auto-all', 'off')),
	CONSTRAINT "monitored_authors_audiobook_mode_chk" CHECK ("monitored_authors"."audiobook_mode" in ('notify', 'auto-upcoming', 'auto-all', 'off'))
);
--> statement-breakpoint
CREATE TABLE "monitored_books" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"owner_user_id" integer NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"monitor_author_id" varchar(36) NOT NULL,
	"work_id" varchar(255) NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "author_catalog_source_works" ADD CONSTRAINT "author_catalog_source_works_work_id_author_catalog_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."author_catalog_works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_catalog_state" ADD CONSTRAINT "author_catalog_state_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_book_id_books_id_fk" FOREIGN KEY ("matched_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_ebook_book_id_books_id_fk" FOREIGN KEY ("matched_ebook_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_catalog_works" ADD CONSTRAINT "author_catalog_works_matched_audio_book_id_books_id_fk" FOREIGN KEY ("matched_audio_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_provider_identities" ADD CONSTRAINT "author_provider_identities_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_work_id_author_catalog_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."author_catalog_works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_ebook_request_id_book_requests_id_fk" FOREIGN KEY ("ebook_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_author_works" ADD CONSTRAINT "monitored_author_works_audiobook_request_id_book_requests_id_fk" FOREIGN KEY ("audiobook_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_local_author_id_authors_id_fk" FOREIGN KEY ("local_author_id") REFERENCES "public"."authors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_ebook_library_id_libraries_id_fk" FOREIGN KEY ("ebook_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_ebook_folder_id_library_folders_id_fk" FOREIGN KEY ("ebook_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_audiobook_library_id_libraries_id_fk" FOREIGN KEY ("audiobook_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_authors" ADD CONSTRAINT "monitored_authors_audiobook_folder_id_library_folders_id_fk" FOREIGN KEY ("audiobook_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_books" ADD CONSTRAINT "monitored_books_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitored_books" ADD CONSTRAINT "monitored_books_monitor_author_id_monitored_authors_id_fk" FOREIGN KEY ("monitor_author_id") REFERENCES "public"."monitored_authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "author_catalog_source_works_provider_work_id_idx" ON "author_catalog_source_works" USING btree ("provider_work_id");--> statement-breakpoint
CREATE INDEX "author_catalog_works_monitor_author_id_idx" ON "author_catalog_works" USING btree ("monitor_author_id");--> statement-breakpoint
CREATE INDEX "author_catalog_works_monitor_author_verdict_idx" ON "author_catalog_works" USING btree ("monitor_author_id","verdict");--> statement-breakpoint
CREATE INDEX "monitored_author_works_monitor_author_id_idx" ON "monitored_author_works" USING btree ("monitor_author_id");--> statement-breakpoint
CREATE INDEX "monitored_authors_owner_user_id_idx" ON "monitored_authors" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "monitored_books_work_id_idx" ON "monitored_books" USING btree ("work_id");