CREATE TABLE "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"zone" text NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'available' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"pallet_id" text NOT NULL,
	"sku_id" integer NOT NULL,
	"task_id" text,
	"action" text NOT NULL,
	"from_location_id" integer,
	"to_location_id" integer,
	"quantity" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_id" integer
);
--> statement-breakpoint
CREATE TABLE "pallets" (
	"id" text PRIMARY KEY NOT NULL,
	"sku_id" integer NOT NULL,
	"location_id" integer,
	"remarks" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"inbound_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_schema_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sku_catalog" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"barcode" text DEFAULT '' NOT NULL,
	"client" text DEFAULT '' NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"declared_chinese_name" text DEFAULT '' NOT NULL,
	"source_row" integer NOT NULL,
	"import_key" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"imported_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"unit" text DEFAULT '箱' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "task_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"pallet_id" text,
	"sku_id" integer NOT NULL,
	"from_location_id" integer,
	"to_location_id" integer,
	"planned_quantity" integer NOT NULL,
	"actual_quantity" integer,
	"returned_quantity" integer DEFAULT 0 NOT NULL,
	"note" text,
	"outcome" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_id" integer,
	"created_by_id" integer,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"role" text DEFAULT 'operator' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "warehouse_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_pallet_id_pallets_id_fk" FOREIGN KEY ("pallet_id") REFERENCES "public"."pallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movements" ADD CONSTRAINT "movements_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_pallet_id_pallets_id_fk" FOREIGN KEY ("pallet_id") REFERENCES "public"."pallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_code_type_unique" ON "locations" USING btree ("code","type");--> statement-breakpoint
CREATE INDEX "locations_type_zone_idx" ON "locations" USING btree ("type","zone");--> statement-breakpoint
CREATE INDEX "movements_pallet_time_idx" ON "movements" USING btree ("pallet_id","occurred_at");--> statement-breakpoint
CREATE INDEX "movements_sku_time_idx" ON "movements" USING btree ("sku_id","occurred_at");--> statement-breakpoint
CREATE INDEX "movements_time_idx" ON "movements" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "movements_from_time_idx" ON "movements" USING btree ("from_location_id","occurred_at");--> statement-breakpoint
CREATE INDEX "movements_to_time_idx" ON "movements" USING btree ("to_location_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pallets_sku_idx" ON "pallets" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "pallets_location_idx" ON "pallets" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sku_catalog_code_active_idx" ON "sku_catalog" USING btree ("code","active");--> statement-breakpoint
CREATE INDEX "sku_catalog_client_idx" ON "sku_catalog" USING btree ("client");--> statement-breakpoint
CREATE INDEX "sku_catalog_import_idx" ON "sku_catalog" USING btree ("import_key");--> statement-breakpoint
CREATE INDEX "task_items_task_idx" ON "task_items" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_items_resolved_time_idx" ON "task_items" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "tasks_status_type_idx" ON "tasks" USING btree ("status","type");