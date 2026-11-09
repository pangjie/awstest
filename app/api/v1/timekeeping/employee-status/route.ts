import { NextResponse } from "next/server";
import { getPool } from "@/db";
import { authorizePageAccess } from "@/lib/internal-auth";
import { getTimeRevision } from "@/lib/timekeeping/data";
import { workDate } from "@/lib/timekeeping/time";
import { employeeStatus,sortStatusEmployees } from "@/lib/employee-status";

export const dynamic="force-dynamic";

export async function GET(){
  const access=await authorizePageAccess("time-employees");
  if(!access.authorized)return NextResponse.json({error:access.message},{status:access.status,headers:{"cache-control":"no-store"}});
  // Capture the revision first so a concurrent commit is picked up by the next check.
  const revision=await getTimeRevision();
  const date=workDate();
  const generatedAt=new Date().toISOString();
  const {rows}=await getPool().query<{
    id:number;name:string;on_duty:boolean;has_attendance:boolean;task_code:string|null;task_ms:string;standby_ms:string;
    task_active:boolean|null;work_type:string|null;barcode:string|null;task_name:string|null;wave_no:string|null;
  }>(`SELECT e.id,e.name,COALESCE(a.on_duty,false) AS on_duty,a.has_attendance,
      t.task_active,t.work_type,t.barcode,t.code AS task_code,t.name AS task_name,t.wave_no,
      COALESCE(d.task_ms,0) AS task_ms,GREATEST(0,a.on_duty_ms-COALESCE(d.work_ms,0)) AS standby_ms
    FROM time_employees e
    CROSS JOIN LATERAL (
      SELECT count(*)>0 AS has_attendance,bool_or(status='open') AS on_duty,
        COALESCE(sum(GREATEST(0,EXTRACT(EPOCH FROM (LEAST(COALESCE(clock_out,$2::timestamptz),$2::timestamptz)-clock_in))*1000)),0) AS on_duty_ms
      FROM time_shifts WHERE employee_id=e.id AND work_date=$1
    ) a
    LEFT JOIN LATERAL (
      SELECT w.id,w.code,w.name,w.wave_no,w.work_type,w.barcode,
        (s.ended_at IS NULL AND sh.status='open' AND w.status='active') AS task_active,
        w.status AS task_status
      FROM time_work_sessions s JOIN time_shifts sh ON sh.id=s.shift_id
      JOIN time_work_items w ON w.id=s.work_item_id
      WHERE s.employee_id=e.id AND sh.work_date=$1
      ORDER BY s.started_at DESC,s.id DESC LIMIT 1
    ) t ON t.task_status='active'
    LEFT JOIN LATERAL (
      SELECT sum(duration_ms) AS work_ms,sum(duration_ms) FILTER (WHERE work_item_id=t.id) AS task_ms
      FROM (
        SELECT s.work_item_id,GREATEST(0,EXTRACT(EPOCH FROM (
          LEAST(COALESCE(s.ended_at,$2::timestamptz),COALESCE(sh.clock_out,$2::timestamptz),$2::timestamptz)
          -GREATEST(s.started_at,sh.clock_in)))*1000) AS duration_ms
        FROM time_work_sessions s JOIN time_shifts sh ON sh.id=s.shift_id
        WHERE s.employee_id=e.id AND sh.work_date=$1
      ) durations
    ) d ON true
    WHERE e.active=true`,[date,generatedAt]);
  const employees=sortStatusEmployees(rows.map(row=>{
    const state=employeeStatus(row.on_duty,row.has_attendance,Boolean(row.task_active),row.work_type,row.barcode);
    const task=(state==="picking"||state==="warehouse"||state==="off")&&row.task_name
      ?`${row.work_type==="wave"?`波次 ${row.wave_no||row.task_name}`:row.task_name}${state==="off"?" · 已暂停":""}`:null;
    return {id:row.id,name:row.name,state,task,taskCode:task?(row.work_type==="wave"?"WAVE":row.task_code):null,elapsedMs:state==="ready"?Number(row.standby_ms):task?Number(row.task_ms):0};
  }));
  return NextResponse.json({revision,date,generatedAt,employees},{headers:{"cache-control":"no-store"}});
}
