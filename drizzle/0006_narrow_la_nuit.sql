CREATE TABLE "replies" (
	"confession_id" integer NOT NULL,
	"ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replies_confession_id_ts_pk" PRIMARY KEY("confession_id","ts")
);
--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_confession_id_confessions_id_fk" FOREIGN KEY ("confession_id") REFERENCES "public"."confessions"("id") ON DELETE no action ON UPDATE no action;