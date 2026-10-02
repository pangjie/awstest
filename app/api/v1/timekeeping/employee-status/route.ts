import { NextResponse } from "next/server";
import { getPool } from "@/db";
import { authorizePageAccess } from "@/lib/internal-auth";
import { getTimeRevision } from "@/lib/timekeeping/data";
import { workDate } from "@/lib/timekeeping/time";
import { employeeStatus,sortStatusEmployees } from "@/lib/employee-status";

export const dynamic="force-dynamic";

export async function GET(){
  const access=await authorizePageAccess("time-status");
  if(!access.authorized)return NextResponse.json({error:access.message},{status:access.status,headers:{"cache-control":"no-store"}});
  // Capture the revision first so a concurrent commit is picked up by the next check.
  const revision=await getTimeRevision();
  const date=workDate();
  const {rows}=await getPool().query<{
    id:number;name:string;on_duty:boolean;has_attendance:boolean;
    task_active:boolean|null;work_type:string|null;barcode:string|null;task_name:string|null;wave_no:string|null;
  }>(`SELECT e.id,e.name,COALESCE(a.on_duty,false) AS on_duty,a.has_attendance,
      t.task_active,t.work_type,t.barcode,t.name AS task_name,t.wave_no
    FROM time_employees e
    CROSS JOIN LATERAL (
      SELECT count(*)>0 AS has_attendance,bool_or(status='open') AS on_duty
      FROM time_shifts WHERE employee_id=e.id AND work_date=$1
    ) a
    LEFT JOIN LATERAL (
      SELECT w.name,w.wave_no,w.work_type,w.barcode,
        (s.ended_at IS NULL AND sh.status='open' AND w.status='active') AS task_active,
        w.status AS task_status
      FROM time_work_sessions s JOIN time_shifts sh ON sh.id=s.shift_id
      JOIN time_work_items w ON w.id=s.work_item_id
      WHERE s.employee_id=e.id AND sh.work_date=$1
      ORDER BY s.started_at DESC,s.id DESC LIMIT 1
    ) t ON t.task_status='active'
    WHERE e.active=true`,[date]);
  const employees=sortStatusEmployees(rows.map(row=>{
    const state=employeeStatus(row.on_duty,row.has_attendance,Boolean(row.task_active),row.work_type,row.barcode);
    const task=(state==="picking"||state==="warehouse"||state==="off")&&row.task_name
      ?`${row.work_type==="wave"?`波次 ${row.wave_no||row.task_name}`:row.task_name}${state==="off"?" · 已暂停":""}`:null;
    return {id:row.id,name:row.name,state,task};
  }));
  return NextResponse.json({revision,date,generatedAt:new Date().toISOString(),employees},{headers:{"cache-control":"no-store"}});
}
