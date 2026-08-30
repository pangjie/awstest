import { and, eq, ne, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { ensureTimekeepingSchema } from "../../../../../db/timekeeping-runtime";
import { timeAttendanceEdits,timeEmployees,timeShifts,timeWorkSessionEdits,timeWorkSessions } from "../../../../../db/timekeeping-schema";
import { authorizePageAccess } from "../../../../../lib/internal-auth";
import { lockTimekeeping, recordTimeRevision } from "../../../../../lib/timekeeping/data";
import { isValidEmployeeId, sanitizeEmployeeId } from "../../../../../lib/timekeeping/employee-id";
import { readEmployeeReport } from "../../../../../lib/timekeeping/read-model";
import { localDateTimeToIso, workDate } from "../../../../../lib/timekeeping/time";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest){
  const access=await authorizePageAccess("time-records");
  if(!access.authorized)return denied(access);
  const badge=sanitizeEmployeeId(request.nextUrl.searchParams.get("badge")??"");
  if(!isValidEmployeeId(badge))return error("请输入有效的八位员工 ID",400);
  const report=await readEmployeeReport(badge,request.nextUrl.searchParams.get("period"));
  if(!report)return error("未找到这个员工 ID",404);
  return NextResponse.json(report,{headers:{"cache-control":"no-store"}});
}

export async function PATCH(request:NextRequest){
  const access=await authorizePageAccess("time-records");
  if(!access.authorized)return denied(access);
  if(access.user.role!=="admin")return error("仅管理员可修改时间记录",403);
  await ensureTimekeepingSchema();
  const body=await request.json().catch(()=>({})) as Record<string,unknown>;
  const badge=sanitizeEmployeeId(String(body.badge??""));
  const requestId=String(body.requestId??"").trim().slice(0,100);
  const target=body.target==="work_session"?"work_session":"attendance";
  const shiftId=Number(body.shiftId);
  const sessionId=Number(body.sessionId);
  const attendanceField=body.field==="clock_in"||body.field==="clock_out"?body.field:null;
  const sessionField=body.field==="started_at"||body.field==="ended_at"?body.field:null;
  const localTime=String(body.localTime??"").trim();
  const note=String(body.note??"").normalize("NFKC").trim();
  const expected=String(body.expectedOldTimestamp??"").trim();
  if(!isValidEmployeeId(badge))return error("员工 ID 无效",400);
  if(!requestId)return error("修改请求编号无效",400);
  if(target==="attendance"&&(!Number.isInteger(shiftId)||shiftId<1||!attendanceField))return error("只能修改有效的 Sign In 或 Sign Out 记录",400);
  if(target==="work_session"&&(!Number.isInteger(sessionId)||sessionId<1||!sessionField))return error("只能修改有效的工作开始或结束时间",400);
  if(!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(localTime))return error("请输入有效的时间",400);
  if(!expected||Number.isNaN(new Date(expected).getTime()))return error("原始时间无效，请刷新后重试",400);
  if(!note)return error("修改时间必须填写备注",400);
  if(note.length>300)return error("备注不能超过 300 个字符",400);

  const result=await getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const employee=(await tx.select().from(timeEmployees).where(or(eq(timeEmployees.employeeCode,badge),eq(timeEmployees.badgeCode,badge))).limit(1))[0];
    if(!employee)return {error:"未找到这个员工 ID",status:404 as const};
    if(target==="work_session"){
      const field=sessionField!;
      const duplicate=await tx.select({id:timeWorkSessionEdits.id}).from(timeWorkSessionEdits).where(eq(timeWorkSessionEdits.requestId,requestId)).limit(1);
      if(duplicate.length)return {duplicate:true as const,message:"该工作时间修改已经保存"};
      const session=(await tx.select({
        id:timeWorkSessions.id,employeeId:timeWorkSessions.employeeId,shiftId:timeWorkSessions.shiftId,startedAt:timeWorkSessions.startedAt,endedAt:timeWorkSessions.endedAt,
        workDate:timeShifts.workDate,shiftClockIn:timeShifts.clockIn,shiftClockOut:timeShifts.clockOut,
      }).from(timeWorkSessions).innerJoin(timeShifts,eq(timeWorkSessions.shiftId,timeShifts.id)).where(and(eq(timeWorkSessions.id,sessionId),eq(timeWorkSessions.employeeId,employee.id))).limit(1))[0];
      if(!session)return {error:"未找到这条工作时间记录",status:404 as const};
      const oldTimestamp=field==="started_at"?session.startedAt:session.endedAt;
      if(!oldTimestamp)return {error:"尚未产生的工作结束时间不能修改",status:400 as const};
      if(new Date(oldTimestamp).toISOString()!==new Date(expected).toISOString())return {error:"工作时间已被其他操作修改，请刷新后重试",status:409 as const};
      let newTimestamp:string;
      try{newTimestamp=localDateTimeToIso(`${session.workDate}T${localTime}`)}catch(cause){return {error:cause instanceof Error?cause.message:"时间格式无效",status:400 as const}}
      if(workDate(newTimestamp)!==session.workDate)return {error:"新时间必须属于该工作记录的日期",status:400 as const};
      if(new Date(newTimestamp).getTime()>Date.now())return {error:"工作时间不能晚于当前时间",status:400 as const};
      if(newTimestamp===new Date(oldTimestamp).toISOString())return {error:"新时间与原时间相同，无需保存",status:400 as const};
      const nextStartedAt=field==="started_at"?newTimestamp:session.startedAt;
      const nextEndedAt=field==="ended_at"?newTimestamp:session.endedAt;
      if(nextEndedAt&&new Date(nextStartedAt)>=new Date(nextEndedAt))return {error:"工作开始时间必须早于结束时间",status:400 as const};
      if(new Date(nextStartedAt)<new Date(session.shiftClockIn)||(session.shiftClockOut&&new Date(nextEndedAt??new Date())>new Date(session.shiftClockOut)))return {error:"工作时间必须完整位于对应的在岗时间内",status:400 as const};
      const overlapEnd=nextEndedAt??new Date().toISOString();
      const overlap=await tx.select({id:timeWorkSessions.id}).from(timeWorkSessions).where(and(eq(timeWorkSessions.employeeId,employee.id),ne(timeWorkSessions.id,session.id),sql`${timeWorkSessions.startedAt}<${overlapEnd}`,sql`COALESCE(${timeWorkSessions.endedAt},CURRENT_TIMESTAMP)>${nextStartedAt}`)).limit(1);
      if(overlap.length)return {error:"修改后的工作时间会与另一条工作记录重叠",status:400 as const};
      await tx.update(timeWorkSessions).set(field==="started_at"?{startedAt:newTimestamp}:{endedAt:newTimestamp}).where(eq(timeWorkSessions.id,session.id));
      await tx.insert(timeWorkSessionEdits).values({requestId,sessionId:session.id,employeeId:employee.id,workDate:session.workDate,sessionField:field,oldTimestamp:new Date(oldTimestamp).toISOString(),newTimestamp,note,editorUserId:access.user.id,editorUsername:access.user.username,editedAt:new Date().toISOString()});
      await recordTimeRevision(tx);
      return {message:`${employee.name} 的工作${field==="started_at"?"开始":"结束"}时间已修改并记录日志`};
    }
    const duplicate=await tx.select({id:timeAttendanceEdits.id}).from(timeAttendanceEdits).where(eq(timeAttendanceEdits.requestId,requestId)).limit(1);
    if(duplicate.length)return {duplicate:true as const,message:"该考勤修改已经保存"};
    const shift=(await tx.select().from(timeShifts).where(and(eq(timeShifts.id,shiftId),eq(timeShifts.employeeId,employee.id))).limit(1))[0];
    if(!shift)return {error:"未找到这条考勤记录",status:404 as const};
    const field=attendanceField!;
    const oldTimestamp=field==="clock_in"?shift.clockIn:shift.clockOut;
    if(!oldTimestamp)return {error:"尚未产生的 Sign Out 时间不能修改",status:400 as const};
    if(new Date(oldTimestamp).toISOString()!==new Date(expected).toISOString())return {error:"考勤时间已被其他操作修改，请刷新后重试",status:409 as const};
    let newTimestamp:string;
    try{newTimestamp=localDateTimeToIso(`${shift.workDate}T${localTime}`)}catch(cause){return {error:cause instanceof Error?cause.message:"时间格式无效",status:400 as const}}
    if(workDate(newTimestamp)!==shift.workDate)return {error:"新时间必须属于该考勤记录的工作日期",status:400 as const};
    if(new Date(newTimestamp).getTime()>Date.now())return {error:"考勤时间不能晚于当前时间",status:400 as const};
    if(newTimestamp===new Date(oldTimestamp).toISOString())return {error:"新时间与原时间相同，无需保存",status:400 as const};
    const nextClockIn=field==="clock_in"?newTimestamp:shift.clockIn;
    const nextClockOut=field==="clock_out"?newTimestamp:shift.clockOut;
    if(nextClockOut&&new Date(nextClockIn)>=new Date(nextClockOut))return {error:"Sign In 必须早于同一班次的 Sign Out",status:400 as const};
    const overlap=await tx.select({id:timeShifts.id}).from(timeShifts).where(and(eq(timeShifts.employeeId,employee.id),ne(timeShifts.id,shift.id),sql`${timeShifts.clockIn}<${nextClockOut??new Date().toISOString()}`,sql`COALESCE(${timeShifts.clockOut},CURRENT_TIMESTAMP)>${nextClockIn}`)).limit(1);
    if(overlap.length)return {error:"修改后的考勤时间会与另一段在岗记录重叠",status:400 as const};
    const outsideWork=await tx.select({id:timeWorkSessions.id}).from(timeWorkSessions).where(nextClockOut
      ?and(eq(timeWorkSessions.shiftId,shift.id),sql`(${timeWorkSessions.startedAt}<${nextClockIn} OR COALESCE(${timeWorkSessions.endedAt},CURRENT_TIMESTAMP)>${nextClockOut})`)
      :and(eq(timeWorkSessions.shiftId,shift.id),sql`${timeWorkSessions.startedAt}<${nextClockIn}`)).limit(1);
    if(outsideWork.length)return {error:"该考勤时间会使已有工作记录落在不在岗区间",status:400 as const};
    await tx.update(timeShifts).set(field==="clock_in"?{clockIn:newTimestamp}:{clockOut:newTimestamp}).where(eq(timeShifts.id,shift.id));
    await tx.insert(timeAttendanceEdits).values({requestId,shiftId:shift.id,employeeId:employee.id,workDate:shift.workDate,attendanceField:field,oldTimestamp:new Date(oldTimestamp).toISOString(),newTimestamp,note,editorUserId:access.user.id,editorUsername:access.user.username,editedAt:new Date().toISOString()});
    await recordTimeRevision(tx);
    return {message:`${employee.name} 的 ${field==="clock_in"?"Sign In":"Sign Out"} 时间已修改并记录日志`};
  });
  if(typeof result.error==="string")return error(result.error,result.status??400);
  return NextResponse.json({ok:true,...result});
}

function error(message:string,status:number){return NextResponse.json({ok:false,error:message},{status})}
function denied(access:{status:401|403;message:string}){return error(access.message,access.status)}
