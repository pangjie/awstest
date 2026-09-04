import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./schema";

const utcTimestamp=(name:string)=>timestamp(name,{withTimezone:true,mode:"string"});

export const timeEmployees=pgTable("time_employees",{
  id:serial("id").primaryKey(),
  badgeCode:text("badge_code").notNull(),
  employeeCode:text("employee_code"),
  name:text("name").notNull(),
  organizationType:text("organization_type",{enum:["OZM","JJC"]}).notNull().default("OZM"),
  defaultWorkItemId:integer("default_work_item_id"),
  active:boolean("active").notNull().default(true),
  createdAt:utcTimestamp("created_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_employees_badge_unique").on(table.badgeCode),
  uniqueIndex("time_employees_code_unique").on(table.employeeCode),
]);

export const timeWorkItems=pgTable("time_work_items",{
  id:serial("id").primaryKey(),
  barcode:text("barcode").notNull(),
  code:text("code").notNull(),
  name:text("name").notNull(),
  client:text("client").notNull().default("内部"),
  workType:text("work_type",{enum:["wave","standard"]}).notNull(),
  waveNo:text("wave_no"),
  channelName:text("channel_name").notNull().default(""),
  channelType:text("channel_type").notNull().default(""),
  skuCount:integer("sku_count").notNull().default(0),
  orderCount:integer("order_count").notNull().default(0),
  pieceCount:integer("piece_count").notNull().default(0),
  sortOrder:integer("sort_order").notNull().default(0),
  status:text("status",{enum:["active","completed"]}).notNull().default("active"),
  interruptedAt:utcTimestamp("interrupted_at"),
  completedAt:utcTimestamp("completed_at"),
  createdAt:utcTimestamp("created_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_work_items_barcode_unique").on(table.barcode),
  uniqueIndex("time_work_items_code_unique").on(table.code),
  uniqueIndex("time_work_items_wave_unique").on(table.waveNo),
  index("time_work_items_status_idx").on(table.workType,table.status,table.sortOrder),
]);

export const timeShifts=pgTable("time_shifts",{
  id:serial("id").primaryKey(),
  employeeId:integer("employee_id").notNull().references(()=>timeEmployees.id),
  workDate:text("work_date").notNull(),
  clockIn:utcTimestamp("clock_in").notNull(),
  clockOut:utcTimestamp("clock_out"),
  status:text("status",{enum:["open","closed"]}).notNull().default("open"),
  createdAt:utcTimestamp("created_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_shifts_employee_open_unique").on(table.employeeId).where(sql`${table.status}='open'`),
  index("time_shifts_employee_date_idx").on(table.employeeId,table.workDate),
  check("time_shifts_clock_order",sql`${table.clockOut} IS NULL OR ${table.clockOut}>${table.clockIn}`),
]);

export const timeAttendanceEdits=pgTable("time_attendance_edits",{
  id:serial("id").primaryKey(),
  requestId:text("request_id").notNull(),
  shiftId:integer("shift_id").notNull().references(()=>timeShifts.id),
  employeeId:integer("employee_id").notNull().references(()=>timeEmployees.id),
  workDate:text("work_date").notNull(),
  attendanceField:text("attendance_field",{enum:["clock_in","clock_out"]}).notNull(),
  oldTimestamp:utcTimestamp("old_timestamp").notNull(),
  newTimestamp:utcTimestamp("new_timestamp").notNull(),
  note:text("note").notNull(),
  editorUserId:integer("editor_user_id").references(()=>users.id),
  editorUsername:text("editor_username").notNull(),
  editedAt:utcTimestamp("edited_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_attendance_edits_request_unique").on(table.requestId),
  index("time_attendance_edits_employee_date_idx").on(table.employeeId,table.workDate),
]);

export const timeWorkSessions=pgTable("time_work_sessions",{
  id:serial("id").primaryKey(),
  shiftId:integer("shift_id").notNull().references(()=>timeShifts.id),
  employeeId:integer("employee_id").notNull().references(()=>timeEmployees.id),
  workItemId:integer("work_item_id").notNull().references(()=>timeWorkItems.id),
  startedAt:utcTimestamp("started_at").notNull(),
  endedAt:utcTimestamp("ended_at"),
},table=>[
  uniqueIndex("time_work_sessions_employee_active_unique").on(table.employeeId).where(sql`${table.endedAt} IS NULL`),
  index("time_work_sessions_employee_time_idx").on(table.employeeId,table.startedAt),
  index("time_work_sessions_item_time_idx").on(table.workItemId,table.startedAt),
]);

export const timeWorkSessionEdits=pgTable("time_work_session_edits",{
  id:serial("id").primaryKey(),
  requestId:text("request_id").notNull(),
  sessionId:integer("session_id").notNull().references(()=>timeWorkSessions.id),
  employeeId:integer("employee_id").notNull().references(()=>timeEmployees.id),
  workDate:text("work_date").notNull(),
  sessionField:text("session_field",{enum:["started_at","ended_at"]}).notNull(),
  oldTimestamp:utcTimestamp("old_timestamp").notNull(),
  newTimestamp:utcTimestamp("new_timestamp").notNull(),
  note:text("note").notNull(),
  editorUserId:integer("editor_user_id").references(()=>users.id),
  editorUsername:text("editor_username").notNull(),
  editedAt:utcTimestamp("edited_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_work_session_edits_request_unique").on(table.requestId),
  index("time_work_session_edits_employee_date_idx").on(table.employeeId,table.workDate),
]);

export const timeWaveAssignments=pgTable("time_wave_assignments",{
  id:serial("id").primaryKey(),
  workItemId:integer("work_item_id").notNull().references(()=>timeWorkItems.id,{onDelete:"cascade"}),
  employeeId:integer("employee_id").notNull().references(()=>timeEmployees.id),
  role:text("role",{enum:["lead","helper"]}).notNull(),
  assignedAt:utcTimestamp("assigned_at").notNull().defaultNow(),
},table=>[
  uniqueIndex("time_wave_assignments_item_employee_unique").on(table.workItemId,table.employeeId),
  uniqueIndex("time_wave_assignments_item_lead_unique").on(table.workItemId).where(sql`${table.role}='lead'`),
  index("time_wave_assignments_employee_idx").on(table.employeeId),
]);

export const timeScanEvents=pgTable("time_scan_events",{
  id:text("id").primaryKey(),
  terminalId:text("terminal_id").notNull(),
  operatorUserId:integer("operator_user_id").references(()=>users.id),
  operatorUsername:text("operator_username").notNull(),
  employeeId:integer("employee_id").references(()=>timeEmployees.id),
  workItemId:integer("work_item_id").references(()=>timeWorkItems.id),
  scannedCode:text("scanned_code").notNull(),
  eventType:text("event_type").notNull(),
  outcome:text("outcome").notNull(),
  responsePayload:jsonb("response_payload").notNull(),
  occurredAt:utcTimestamp("occurred_at").notNull().defaultNow(),
},table=>[
  index("time_scan_events_terminal_time_idx").on(table.terminalId,table.occurredAt),
  index("time_scan_events_employee_time_idx").on(table.employeeId,table.occurredAt),
]);

export const timeRevisions=pgTable("time_revisions",{
  id:serial("id").primaryKey(),
  changedAt:utcTimestamp("changed_at").notNull().defaultNow(),
});

export const timeRuntimeSchemaState=pgTable("time_runtime_schema_state",{
  id:integer("id").primaryKey(),
  version:integer("version").notNull(),
  updatedAt:utcTimestamp("updated_at").notNull().defaultNow(),
});
