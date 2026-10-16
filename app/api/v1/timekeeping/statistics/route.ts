import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/db";
import { authorizePageAccess } from "@/lib/internal-auth";
import { addDays, localDateTimeToIso, workDate } from "@/lib/timekeeping/time";
import { statisticsRange, STATS_MAX_RECORDS } from "@/lib/timekeeping/statistics";

export const dynamic="force-dynamic";
export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-statistics");
  const headers={"Cache-Control":"private, no-store"};
  if(!access.authorized)return NextResponse.json({error:access.message},{status:access.status,headers});
  const params=request.nextUrl.searchParams;
  const requestedSnapshot=params.get("snapshotAt");
  let range:ReturnType<typeof statisticsRange>,cursor:string;
  try{
    if(requestedSnapshot&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(requestedSnapshot)||!Number.isFinite(Date.parse(requestedSnapshot))||Date.parse(requestedSnapshot)>Date.now()))throw new Error("统计截止时间无效");
    const today=requestedSnapshot?workDate(requestedSnapshot):workDate();
    range=statisticsRange(params.get("startDate")??"",params.get("endDate")??"",today);
    cursor=params.get("cursor")??range.startDate;
    statisticsRange(cursor,cursor,today);
    if(cursor<range.startDate||cursor>range.endDate)throw new Error("分页日期无效");
    if(cursor!==range.startDate&&(!requestedSnapshot||!params.has("revision")))throw new Error("分页缺少统计快照，请重新查询");
    if(cursor===range.startDate&&requestedSnapshot)throw new Error("首次查询由服务器确定统计截止时间");
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"日期无效"},{status:400,headers})}
  const pageEnd=[addDays(cursor,6),range.endDate].sort()[0];
  const client=await getPool().connect();
  try{
    // No schema initialization or stale-shift reconciliation: this endpoint never changes history.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='10s'");
    const snapshot=(await client.query("SELECT COALESCE(MAX(id),0) AS revision, statement_timestamp() AS cutoff FROM time_revisions")).rows[0];
    const revision=String(snapshot.revision);
    const snapshotAt=requestedSnapshot??new Date(snapshot.cutoff).toISOString();
    if(params.has("revision")&&params.get("revision")!==revision){
      return NextResponse.json({error:"读取期间工时数据发生变化，请重新查询以取得一致结果"},{status:409,headers});
    }
    const limit=STATS_MAX_RECORDS+1;
    const employees=cursor===range.startDate?(await client.query(`SELECT id,name,organization_type AS organization,active FROM time_employees ORDER BY id LIMIT ${limit}`)).rows:[];
    const shifts=(await client.query(`SELECT s.id,s.employee_id AS "employeeId",s.work_date AS date,s.clock_in AS start,s.clock_out AS end,
      EXISTS(SELECT 1 FROM time_attendance_edits e WHERE e.shift_id=s.id) AS modified
      FROM time_shifts s WHERE s.work_date BETWEEN $1 AND $2 ORDER BY s.id LIMIT ${limit}`,[cursor,pageEnd])).rows;
    const sessions=(await client.query(`SELECT ws.id,ws.employee_id AS "employeeId",ws.shift_id AS "shiftId",ws.work_item_id AS "itemId",ws.started_at AS start,ws.ended_at AS end,
      EXISTS(SELECT 1 FROM time_work_session_edits e WHERE e.session_id=ws.id) AS modified
      FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id
      WHERE s.work_date BETWEEN $1 AND $2 ORDER BY ws.id LIMIT ${limit}`,[cursor,pageEnd])).rows;
    const items=(await client.query(`SELECT wi.id,wi.name,wi.code,wi.work_type AS kind,wi.wave_no AS "waveNo",wi.channel_name AS channel,wi.channel_type AS type,wi.status,wi.created_at AS "createdAt",wi.completed_at AS "completedAt",wi.order_count AS orders,wi.piece_count AS pieces
      FROM time_work_items wi WHERE wi.work_type='standard' OR (wi.created_at >= $3 AND wi.created_at < $4)
      OR EXISTS(SELECT 1 FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id WHERE ws.work_item_id=wi.id AND s.work_date BETWEEN $1 AND $2)
      ORDER BY wi.id LIMIT ${limit}`,[cursor,pageEnd,localDateTimeToIso(`${cursor}T00:00`),localDateTimeToIso(`${addDays(pageEnd,1)}T00:00`)])).rows;
    if([employees,shifts,sessions,items].some(rows=>rows.length>STATS_MAX_RECORDS))return NextResponse.json({error:"数据量过大，请缩短日期范围"},{status:413,headers});
    await client.query("COMMIT");
    return NextResponse.json({ok:true,startDate:range.startDate,endDate:range.endDate,generatedAt:snapshotAt,snapshotAt,revision,next:pageEnd<range.endDate?addDays(pageEnd,1):null,employees,shifts,sessions,items},{headers});
  }catch(error){
    console.error("statistics_read_failed",error instanceof Error?error.name:"unknown");
    return NextResponse.json({error:"统计明细暂时无法读取，请重试或缩短日期范围"},{status:503,headers});
  }finally{
    let broken=false;try{await client.query("ROLLBACK")}catch{broken=true}client.release(broken);
  }
}
