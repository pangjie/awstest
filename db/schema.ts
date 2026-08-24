import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const utcTimestamp = (name:string) => timestamp(name, { withTimezone:true, mode:"string" });

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  role: text("role", { enum:["admin","manager","operator"] }).notNull().default("operator"),
  active: boolean("active").notNull().default(true),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete:"cascade" }),
  expiresAt: utcTimestamp("expires_at").notNull(),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
}, t => [index("sessions_user_idx").on(t.userId), index("sessions_expiry_idx").on(t.expiresAt)]);

export const locations = pgTable("locations", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  type: text("type", { enum:["reserve","pick"] }).notNull(),
  zone: text("zone").notNull(),
  capacity: integer("capacity").notNull().default(1),
  status: text("status", { enum:["available","occupied"] }).notNull().default("available"),
}, t => [uniqueIndex("locations_code_type_unique").on(t.code,t.type), index("locations_type_zone_idx").on(t.type,t.zone)]);

export const skus = pgTable("skus", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  unit: text("unit").notNull().default("箱"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
});

export const skuCatalog = pgTable("sku_catalog", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  barcode: text("barcode").notNull().default(""),
  client: text("client").notNull().default(""),
  productName: text("product_name").notNull().default(""),
  declaredChineseName: text("declared_chinese_name").notNull().default(""),
  sourceRow: integer("source_row").notNull(),
  importKey: text("import_key").notNull(),
  active: boolean("active").notNull().default(false),
  importedAt: utcTimestamp("imported_at").notNull(),
}, t => [
  index("sku_catalog_code_active_idx").on(t.code,t.active),
  index("sku_catalog_client_idx").on(t.client),
  index("sku_catalog_import_idx").on(t.importKey),
]);

export const pallets = pgTable("pallets", {
  id: text("id").primaryKey(),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  locationId: integer("location_id").references(() => locations.id),
  remarks: text("remarks").notNull().default(""),
  status: text("status", { enum:["in_stock","in_task","depleted"] }).notNull().default("in_stock"),
  inboundAt: utcTimestamp("inbound_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
}, t => [index("pallets_sku_idx").on(t.skuId), index("pallets_location_idx").on(t.locationId)]);

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  type: text("type", { enum:["store","pick","move"] }).notNull(),
  status: text("status", { enum:["pending","claimed","completed","returned","partial","cancelled"] }).notNull().default("pending"),
  priority: text("priority", { enum:["normal","urgent"] }).notNull().default("normal"),
  assigneeId: integer("assignee_id").references(() => users.id),
  createdById: integer("created_by_id").references(() => users.id),
  dueAt: utcTimestamp("due_at"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  completedAt: utcTimestamp("completed_at"),
  note: text("note"),
}, t => [index("tasks_status_type_idx").on(t.status,t.type)]);

export const taskItems = pgTable("task_items", {
  id: serial("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  palletId: text("pallet_id").references(() => pallets.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  fromLocationId: integer("from_location_id").references(() => locations.id),
  toLocationId: integer("to_location_id").references(() => locations.id),
  plannedQuantity: integer("planned_quantity").notNull(),
  actualQuantity: integer("actual_quantity"),
  returnedQuantity: integer("returned_quantity").notNull().default(0),
  note: text("note"),
  outcome: text("outcome", { enum:["completed","returned","partial"] }),
  resolvedAt: utcTimestamp("resolved_at"),
}, t => [index("task_items_task_idx").on(t.taskId), index("task_items_resolved_time_idx").on(t.resolvedAt)]);

export const movements = pgTable("movements", {
  id: serial("id").primaryKey(),
  sourceRecordId: integer("source_record_id"),
  palletId: text("pallet_id").notNull().references(() => pallets.id),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  taskId: text("task_id").references(() => tasks.id),
  sourceTaskId: text("source_task_id"),
  action: text("action", { enum:["inbound","pick","partial_pick","move","return","adjust"] }).notNull(),
  fromLocationId: integer("from_location_id").references(() => locations.id),
  toLocationId: integer("to_location_id").references(() => locations.id),
  quantity: integer("quantity").notNull(),
  remarks: text("remarks"),
  occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
  operatorId: integer("operator_id").references(() => users.id),
  sourceOperatorUsername: text("source_operator_username"),
  sourceOperatorName: text("source_operator_name"),
}, t => [
  index("movements_pallet_time_idx").on(t.palletId,t.occurredAt),
  index("movements_sku_time_idx").on(t.skuId,t.occurredAt),
  index("movements_time_idx").on(t.occurredAt),
  index("movements_from_time_idx").on(t.fromLocationId,t.occurredAt),
  index("movements_to_time_idx").on(t.toLocationId,t.occurredAt),
]);

export const warehouseRevisions = pgTable("warehouse_revisions", {
  id: serial("id").primaryKey(),
  changedAt: utcTimestamp("changed_at").notNull().defaultNow(),
});

export const runtimeSchemaState = pgTable("runtime_schema_state", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
