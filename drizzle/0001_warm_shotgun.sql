CREATE TABLE "license_devices" (
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id"),
	CONSTRAINT "license_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"user_id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_devices" integer NOT NULL,
	"channel_limit" integer NOT NULL,
	CONSTRAINT "licenses_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "license_devices" ADD CONSTRAINT "license_devices_user_id_licenses_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."licenses"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;