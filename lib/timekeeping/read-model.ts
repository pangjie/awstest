import { getPool } from "../../db";
import { ensureTimekeepingSchema } from "../../db/timekeeping-runtime";
import { getEmployeeSnapshot, getTimeRevision, reconcileStaleOpenShifts } from "./data";
import { dashboardRangeBounds } from "./dashboard-range";
import { durationMs, monthRange, workDate } from "./time";

type Timestamp=string|Date;
type EmployeeRow={id:number;badge_code:string;name:string;organization_type:"OZM"|"JJC";active:boolean;created_at:Timestamp};
type ShiftRow={id:number;employee_id:number;work_date:string;clock_in:Timestamp;clock_out:Timestamp|null;status:"open"|"closed"};
type SessionRow={id:number;shift_id:number;employee_id:number;work_item_id:number;started_at:Timestamp;ended_at:Timestamp|null;shift_clock_in:Timestamp;shift_clock_out:Timestamp|null;work_date:string};
type SessionEditRow={id:number;request_id:string;session_id:number;work_date:string;session_field:"started_at"|"ended_at";old_timestamp:Timestamp;new_timestamp:Timestamp;note:string;editor_username:string;edited_at:Timestamp;work_code:string;work_name:string};
type WorkItemRow={id:number;barcode:string;code:string;name:string;client:string;work_type:"wave"|"standard";wave_no:string|null;channel_name:string;channel_type:string;sku_count:number;order_count:number;piece_count:number;sort_order:number;status:"active"|"completed";interrupted_at:Timestamp|null;completed_at:Timestamp|null;created_at:Timestamp};
type ParticipantRow=SessionRow&{badge_code:string;employee_name:string;assignment_role:"lead"|"helper"|null};
type ScanEventRow={id:string;event_type:string;outcome:string;response_payload:unknown;occurred_at:Timestamp;operator_username:string;employee_id:number|null;employee_name:string|null};

export async function readEmployees(){
  await ensureTimekeepingSchema();
  await reconcileStaleOpenShifts();
  const today=workDate();
  const now=new Date();
  const pool=getPool();
  const [employeesResult,shiftsResult,currentResult]=await Promise.all([
    pool.query<EmployeeRow>(`SELECT id,COALESCE(employee_code,badge_code) AS badge_code,name,organization_type,active,created_at
      FROM time_employees ORDER BY active DESC,organization_type,COALESCE(employee_code,badge_code)`),
    pool.query<ShiftRow>(`SELECT id,employee_id,work_date,clock_in,clock_out,status FROM time_shifts
      WHERE work_date=$1 ORDER BY clock_in`,[today]),
    pool.query<{employee_id:number;code:string;name:string}>(`SELECT DISTINCT ON (ws.employee_id)
        ws.employee_id,wi.code,wi.name FROM time_work_sessions ws
      JOIN time_work_items wi ON wi.id=ws.work_item_id JOIN time_shifts s ON s.id=ws.shift_id
      WHERE ws.ended_at IS NULL AND s.status='open' ORDER BY ws.employee_id,ws.started_at DESC`),
  ]);
  const currentByEmployee=new Map(currentResult.rows.map(row=>[row.employee_id,{code:row.code,name:row.name}]));
  return {
    ok:true as const,
    generatedAt:new Date().toISOString(),
    period:{today},
    employees:employeesResult.rows.map(employee=>{
      const shifts=shiftsResult.rows.filter(row=>row.employee_id===employee.id);
      const todayShifts=shifts.filter(row=>row.work_date===today);
      const open=todayShifts.find(row=>row.status==="open");
      const currentProject=currentByEmployee.get(employee.id)??null;
      const total=(items:ShiftRow[])=>items.reduce((sum,row)=>sum+durationMs(row.clock_in,row.clock_out??now),0);
      const todayFirstSignIn=todayShifts[0]?.clock_in;
      const todayLastSignOut=todayShifts.filter(row=>row.clock_out).at(-1)?.clock_out;
      const todayMs=total(todayShifts);
      const attendanceEnd=open?now:todayLastSignOut??todayFirstSignIn;
      return {
        id:employee.id,badgeCode:employee.badge_code,name:employee.name,type:employee.organization_type,active:employee.active,
        attendanceState:!employee.active?"inactive":open?(currentProject?"working":"ready"):todayShifts.length?"off":"not_started",
        currentProject,
        todayFirstSignIn:toIsoOrNull(todayFirstSignIn),
        todayLastSignOut:toIsoOrNull(todayLastSignOut),
        todayOffDutyMs:todayFirstSignIn&&attendanceEnd?Math.max(0,durationMs(todayFirstSignIn,attendanceEnd)-todayMs):0,
        todayMs,
        createdAt:toIso(employee.created_at),
      };
    }),
  };
}

export async function readWorkItems({includeHistory=true}:{includeHistory?:boolean}={}){
  await ensureTimekeepingSchema();
  await reconcileStaleOpenShifts();
  const pool=getPool();
  const [itemsResult,sessionsResult]=await Promise.all([
    pool.query<WorkItemRow>(`SELECT id,barcode,code,name,client,work_type,wave_no,channel_name,channel_type,
      sku_count,order_count,piece_count,sort_order,status,interrupted_at,completed_at,created_at FROM time_work_items
      WHERE ${includeHistory?"work_type='wave' OR status='active'":"status='active'"}
      ORDER BY CASE WHEN work_type='standard' THEN 0 ELSE 1 END,sort_order,id`),
    pool.query<ParticipantRow>(`SELECT ws.id,ws.shift_id,ws.employee_id,ws.work_item_id,ws.started_at,ws.ended_at,
        s.clock_in AS shift_clock_in,s.clock_out AS shift_clock_out,s.work_date,COALESCE(e.employee_code,e.badge_code) AS badge_code,e.name AS employee_name,wa.role AS assignment_role
      FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id
      JOIN time_employees e ON e.id=ws.employee_id
      JOIN time_work_items selected ON selected.id=ws.work_item_id
      LEFT JOIN time_wave_assignments wa ON wa.work_item_id=ws.work_item_id AND wa.employee_id=ws.employee_id
      WHERE ${includeHistory?"selected.work_type='wave' OR selected.status='active'":"selected.status='active'"}
      ORDER BY ws.started_at`),
  ]);
  const now=new Date();
  const sessionsByItem=new Map<number,ParticipantRow[]>();
  for(const session of sessionsResult.rows){
    const sessions=sessionsByItem.get(session.work_item_id);
    if(sessions)sessions.push(session);
    else sessionsByItem.set(session.work_item_id,[session]);
  }
  const mapped=itemsResult.rows.map(item=>{
    const sessions=sessionsByItem.get(item.id)??[];
    const sessionsByEmployee=new Map<number,ParticipantRow[]>();
    for(const session of sessions){
      const employeeSessions=sessionsByEmployee.get(session.employee_id);
      if(employeeSessions)employeeSessions.push(session);
      else sessionsByEmployee.set(session.employee_id,[session]);
    }
    const participants=Array.from(sessionsByEmployee.entries()).map(([employeeId,rows])=>{
      const first=rows[0];
      return {employeeId,badgeCode:first.badge_code,name:first.employee_name,totalMs:rows.reduce((sum,row)=>sum+sessionDuration(row,now),0),firstStartedAt:toIso(first.started_at),lastEndedAt:toIsoOrNull(rows.at(-1)?.ended_at),sessionCount:rows.length,active:rows.some(row=>!row.ended_at&&row.shift_clock_out===null),onDuty:rows.some(row=>row.shift_clock_out===null),role:first.assignment_role==="lead"?"lead" as const:"helper" as const};
    }).sort((a,b)=>Number(b.role==="lead")-Number(a.role==="lead")||a.firstStartedAt.localeCompare(b.firstStartedAt));
    return {
      id:item.id,barcode:item.barcode,code:item.code,waveNo:item.wave_no,name:item.name,client:item.client,channelName:item.channel_name,channelType:item.channel_type,
      workType:item.work_type,skuCount:Number(item.sku_count),orderCount:Number(item.order_count),pieceCount:Number(item.piece_count),sortOrder:Number(item.sort_order),status:item.status,interruptedAt:toIsoOrNull(item.interrupted_at),
      createdAt:toIso(item.created_at),completedAt:toIsoOrNull(item.completed_at),startedAt:toIsoOrNull(sessions[0]?.started_at),lastEndedAt:toIsoOrNull(sessions.at(-1)?.ended_at),
      totalMs:sessions.reduce((sum,row)=>sum+sessionDuration(row,now),0),employeeCount:sessionsByEmployee.size,activeCount:participants.filter(row=>row.active).length,participants,
    };
  });
  return {ok:true as const,generatedAt:now.toISOString(),standardTasks:mapped.filter(item=>item.workType==="standard"),currentWaves:mapped.filter(item=>item.workType==="wave"&&item.status==="active"),historyWaves:mapped.filter(item=>item.workType==="wave"&&item.status==="completed")};
}

export async function readTodayScanOperations(){
  await ensureTimekeepingSchema();
  const today=workDate();
  const range=dashboardRangeBounds(today,today);
  const result=await getPool().query<ScanEventRow>(`SELECT event.id,event.event_type,event.outcome,event.response_payload,event.occurred_at,event.operator_username,event.employee_id,employee.name AS employee_name
    FROM time_scan_events event
    LEFT JOIN time_employees employee ON employee.id=event.employee_id
    WHERE event.occurred_at >= $1 AND event.occurred_at < $2
    ORDER BY event.occurred_at DESC,event.id DESC`,[range.start,range.end]);
  return result.rows.map(row=>{
    const payload=typeof row.response_payload==="object"&&row.response_payload!==null?row.response_payload as {message?:unknown;tone?:unknown}:{};
    const tone=["success","info","warning","error"].includes(String(payload.tone))?String(payload.tone) as "success"|"info"|"warning"|"error":row.outcome==="ok"?"info" as const:"warning" as const;
    return {id:row.id,time:toIso(row.occurred_at),event:row.event_type,tone,message:typeof payload.message==="string"?payload.message:row.event_type,employeeId:row.employee_id,employeeName:row.employee_name??"未识别员工",operator:row.operator_username};
  });
}

export async function readDashboard(requestedStartDate?:string|null,requestedEndDate?:string|null){
  await ensureTimekeepingSchema();
  await reconcileStaleOpenShifts();
  const range=dashboardRangeBounds(requestedStartDate,requestedEndDate);
  const now=new Date();
  const rangeStart=new Date(range.start).getTime();
  const rangeEnd=new Date(range.end).getTime();
  const rangeContainsNow=now.getTime()>=rangeStart&&now.getTime()<rangeEnd;
  const pool=getPool();
  const [employeesResult,shiftsResult,sessionsResult,items]=await Promise.all([
    pool.query<EmployeeRow>("SELECT id,COALESCE(employee_code,badge_code) AS badge_code,name,organization_type,active,created_at FROM time_employees ORDER BY organization_type,name"),
    pool.query<ShiftRow>("SELECT id,employee_id,work_date,clock_in,clock_out,status FROM time_shifts WHERE work_date BETWEEN $1 AND $2 ORDER BY clock_in",[range.startDate,range.endDate]),
    pool.query<ParticipantRow&WorkItemRow>(`SELECT ws.id,ws.shift_id,ws.employee_id,ws.work_item_id,ws.started_at,ws.ended_at,
        s.clock_in AS shift_clock_in,s.clock_out AS shift_clock_out,s.work_date,COALESCE(e.employee_code,e.badge_code) AS badge_code,e.name AS employee_name,
        wi.barcode,wi.code,wi.name,wi.client,wi.work_type,wi.wave_no,wi.channel_name,wi.channel_type,wi.sku_count,wi.order_count,wi.piece_count,wi.sort_order,wi.status,wi.interrupted_at,wi.completed_at,wi.created_at,
        wa.role AS assignment_role
      FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id JOIN time_employees e ON e.id=ws.employee_id
      JOIN time_work_items wi ON wi.id=ws.work_item_id LEFT JOIN time_wave_assignments wa ON wa.work_item_id=wi.id AND wa.employee_id=e.id
      WHERE s.work_date BETWEEN $1 AND $2 ORDER BY ws.started_at`,[range.startDate,range.endDate]),
    readWorkItems(),
  ]);
  const attendance=employeesResult.rows.flatMap(employee=>{
    const shifts=shiftsResult.rows.filter(row=>row.employee_id===employee.id);
    if(!shifts.length)return [];
    const sessions=sessionsResult.rows.filter(row=>row.employee_id===employee.id);
    const current=sessions.find(row=>!row.ended_at&&row.shift_clock_out===null);
    const firstIn=shifts[0].clock_in;
    const open=shifts.some(row=>row.status==="open");
    const onDutyMs=shifts.reduce((sum,row)=>sum+durationMs(row.clock_in,row.clock_out??now),0);
    const productiveMs=sessions.reduce((sum,row)=>sum+sessionDuration(row,now),0);
    const end=open?now.getTime():new Date(shifts.at(-1)?.clock_out??firstIn).getTime();
    return [{employeeId:employee.id,name:employee.name,type:employee.organization_type,employmentActive:employee.active,clockIn:toIso(firstIn),clockOut:open?null:toIsoOrNull(shifts.at(-1)?.clock_out),onDutyMs,productiveMs,offDutyMs:Math.max(0,end-new Date(firstIn).getTime()-onDutyMs),state:!employee.active?"inactive":open?(current?"working":"ready"):"off",currentProject:current?{code:current.code,name:current.name}:null}];
  });
  const rangeSessions=sessionsResult.rows.filter(row=>sessionDurationInRange(row,now,rangeStart,rangeEnd)>0);
  const isActive=(row:ParticipantRow)=>rangeContainsNow&&!row.ended_at&&row.shift_clock_out===null;
  const fixedItems=items.standardTasks.map(item=>{
    const sessions=rangeSessions.filter(row=>row.work_item_id===item.id);
    const participants=Array.from(new Set(sessions.map(row=>row.employee_id))).map(employeeId=>{const rows=sessions.filter(row=>row.employee_id===employeeId);const first=rows[0];return {employeeId,badgeCode:first.badge_code,name:first.employee_name,totalMs:rows.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0),active:rows.some(isActive)}});
    return {id:item.id,code:item.code,name:item.name,sortOrder:item.sortOrder,totalMs:sessions.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0),activeCount:participants.filter(row=>row.active).length,participants};
  });
  const waveSessions=rangeSessions.filter(row=>row.work_type==="wave");
  const visibleWaveIds=new Set(waveSessions.map(row=>row.work_item_id));
  const projectTotals=[...items.currentWaves,...items.historyWaves].toSorted((left,right)=>left.sortOrder-right.sortOrder||left.id-right.id).filter(item=>(
    (item.status==="active"&&rangeContainsNow)
    ||visibleWaveIds.has(item.id)
    ||timestampInRange(item.createdAt,rangeStart,rangeEnd)
  )).map(item=>{
    const sessions=waveSessions.filter(row=>row.work_item_id===item.id);
    const employeeIds=Array.from(new Set(sessions.map(row=>row.employee_id)));
    const participants=employeeIds.map(employeeId=>{
      const rows=sessions.filter(row=>row.employee_id===employeeId);
      const first=rows[0];
      return {employeeId,badgeCode:first.badge_code,name:first.employee_name,totalMs:rows.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0),firstStartedAt:toIso(first.started_at),lastEndedAt:toIsoOrNull(rows.at(-1)?.ended_at),sessionCount:rows.length,active:rows.some(isActive),onDuty:rows.some(row=>row.shift_clock_out===null),role:first.assignment_role==="lead"?"lead" as const:"helper" as const};
    }).sort((a,b)=>Number(b.role==="lead")-Number(a.role==="lead")||a.firstStartedAt.localeCompare(b.firstStartedAt));
    return {...item,startedAt:toIsoOrNull(sessions[0]?.started_at),lastEndedAt:toIsoOrNull(sessions.at(-1)?.ended_at),totalMs:sessions.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0),activeCount:participants.filter(row=>row.active).length,participants};
  });
  const totalMs=rangeSessions.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0);
  const waveMs=waveSessions.reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0);
  const scanMs=rangeSessions.filter(row=>row.barcode==="JOB-SCAN"||row.barcode==="JOB-SINGLE-SCAN").reduce((sum,row)=>sum+sessionDurationInRange(row,now,rangeStart,rangeEnd),0);
  return {
    ok:true as const,date:range.endDate,range,revision:await getTimeRevision(),generatedAt:now.toISOString(),timeZone:"America/New_York",
    filterUniverse:{channels:Array.from(new Set(projectTotals.map(item=>item.channelName).filter(Boolean)))},attendance,
    taskTotals:{totalMs,waveMs,scanMs,otherMs:Math.max(0,totalMs-waveMs-scanMs),activeCount:rangeSessions.filter(isActive).length,waveActiveCount:waveSessions.filter(isActive).length,scanActiveCount:rangeSessions.filter(row=>(row.barcode==="JOB-SCAN"||row.barcode==="JOB-SINGLE-SCAN")&&isActive(row)).length,otherActiveCount:rangeSessions.filter(row=>row.work_type!=="wave"&&row.barcode!=="JOB-SCAN"&&row.barcode!=="JOB-SINGLE-SCAN"&&isActive(row)).length},
    dailyTasks:fixedItems,projectTotals,
  };
}

export async function readEmployeeReport(badge:string,periodId?:string|null){
  await ensureTimekeepingSchema();
  await reconcileStaleOpenShifts();
  const pool=getPool();
  const employee=(await pool.query<EmployeeRow>("SELECT id,COALESCE(employee_code,badge_code) AS badge_code,name,organization_type,active,created_at FROM time_employees WHERE employee_code=$1 OR badge_code=$1",[badge])).rows[0];
  if(!employee)return null;
  const period=monthRange(periodId??undefined);
  const [shiftsResult,sessionsResult,editsResult,sessionEditsResult]=await Promise.all([
    pool.query<ShiftRow>("SELECT id,employee_id,work_date,clock_in,clock_out,status FROM time_shifts WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date,clock_in",[employee.id,period.startDate,period.endDate]),
    pool.query<SessionRow&Pick<WorkItemRow,"code"|"name"|"work_type"|"wave_no"|"channel_name"|"channel_type"|"sku_count"|"order_count"|"piece_count">>(`SELECT ws.id,ws.shift_id,ws.employee_id,ws.work_item_id,ws.started_at,ws.ended_at,s.clock_in AS shift_clock_in,s.clock_out AS shift_clock_out,s.work_date,
        wi.code,wi.name,wi.work_type,wi.wave_no,wi.channel_name,wi.channel_type,wi.sku_count,wi.order_count,wi.piece_count
      FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id JOIN time_work_items wi ON wi.id=ws.work_item_id
      WHERE ws.employee_id=$1 AND s.work_date BETWEEN $2 AND $3 ORDER BY s.work_date,ws.started_at`,[employee.id,period.startDate,period.endDate]),
    pool.query<{id:number;request_id:string;shift_id:number;work_date:string;attendance_field:"clock_in"|"clock_out";old_timestamp:Timestamp;new_timestamp:Timestamp;note:string;editor_username:string;edited_at:Timestamp}>(`SELECT id,request_id,shift_id,work_date,attendance_field,old_timestamp,new_timestamp,note,editor_username,edited_at
      FROM time_attendance_edits WHERE employee_id=$1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date,edited_at,id`,[employee.id,period.startDate,period.endDate]),
    pool.query<SessionEditRow>(`SELECT edit.id,edit.request_id,edit.session_id,edit.work_date,edit.session_field,edit.old_timestamp,edit.new_timestamp,edit.note,edit.editor_username,edit.edited_at,
        item.code AS work_code,item.name AS work_name
      FROM time_work_session_edits edit JOIN time_work_sessions session ON session.id=edit.session_id JOIN time_work_items item ON item.id=session.work_item_id
      WHERE edit.employee_id=$1 AND edit.work_date BETWEEN $2 AND $3 ORDER BY edit.work_date,edit.edited_at,edit.id`,[employee.id,period.startDate,period.endDate]),
  ]);
  const now=new Date();
  const dates=Array.from(new Set(shiftsResult.rows.map(row=>row.work_date)));
  const days=dates.map(date=>{
    const shifts=shiftsResult.rows.filter(row=>row.work_date===date);
    const sessions=sessionsResult.rows.filter(row=>row.work_date===date);
    const onDutyMs=shifts.reduce((sum,row)=>sum+durationMs(row.clock_in,row.clock_out??now),0);
    return {workDate:date,clockIn:toIso(shifts[0].clock_in),clockOut:shifts.some(row=>row.status==="open")?null:toIsoOrNull(shifts.at(-1)?.clock_out),productiveMs:sessions.reduce((sum,row)=>sum+sessionDuration(row,now),0),onDutyMs,offDutyMs:Math.max(0,durationMs(shifts[0].clock_in,shifts.some(row=>row.status==="open")?now:shifts.at(-1)?.clock_out??shifts[0].clock_in)-onDutyMs)};
  });
  const modified=new Set(editsResult.rows.map(row=>`${row.shift_id}:${row.attendance_field}`));
  const modifiedSessions=new Set(sessionEditsResult.rows.map(row=>`${row.session_id}:${row.session_field}`));
  return {
    ok:true as const,generatedAt:now.toISOString(),snapshot:await getEmployeeSnapshot(employee.id),
    period:{...period,totalMs:days.reduce((sum,row)=>sum+row.onDutyMs,0),workedDays:days.length},defaultWorkDate:days.at(-1)?.workDate??period.endDate,days,
    attendanceEvents:shiftsResult.rows.flatMap(row=>[{id:`shift-${row.id}-in`,shiftId:row.id,workDate:row.work_date,field:"clock_in" as const,type:"sign_in" as const,label:"Sign In" as const,timestamp:toIso(row.clock_in),modified:modified.has(`${row.id}:clock_in`)},...(row.clock_out?[{id:`shift-${row.id}-out`,shiftId:row.id,workDate:row.work_date,field:"clock_out" as const,type:"sign_out" as const,label:"Sign Out" as const,timestamp:toIso(row.clock_out),modified:modified.has(`${row.id}:clock_out`)}]:[])]),
    attendanceEdits:editsResult.rows.map(row=>({id:row.id,requestId:row.request_id,shiftId:row.shift_id,workDate:row.work_date,field:row.attendance_field,label:row.attendance_field==="clock_in"?"Sign In":"Sign Out",oldTimestamp:toIso(row.old_timestamp),newTimestamp:toIso(row.new_timestamp),note:row.note,editor:row.editor_username,editedAt:toIso(row.edited_at)})),
    workSessionEdits:sessionEditsResult.rows.map(row=>({id:row.id,requestId:row.request_id,sessionId:row.session_id,workDate:row.work_date,field:row.session_field,label:row.session_field==="started_at"?"开始时间":"结束时间",workCode:row.work_code,workName:row.work_name,oldTimestamp:toIso(row.old_timestamp),newTimestamp:toIso(row.new_timestamp),note:row.note,editor:row.editor_username,editedAt:toIso(row.edited_at)})),
    projects:sessionsResult.rows.map(row=>({id:row.id,workDate:row.work_date,code:row.code,name:row.name,workType:row.work_type,waveNo:row.wave_no,channelName:row.channel_name,channelType:row.channel_type,skuCount:Number(row.sku_count),orderCount:Number(row.order_count),pieceCount:Number(row.piece_count),startedAt:toIso(row.started_at),endedAt:toIsoOrNull(row.ended_at),startedAtModified:modifiedSessions.has(`${row.id}:started_at`),endedAtModified:modifiedSessions.has(`${row.id}:ended_at`),totalMs:sessionDuration(row,now)})),
  };
}

function sessionDuration(row:Pick<SessionRow,"started_at"|"ended_at"|"shift_clock_in"|"shift_clock_out">,now:Date){
  const start=Math.max(new Date(row.started_at).getTime(),new Date(row.shift_clock_in).getTime());
  const end=Math.min(new Date(row.ended_at??now).getTime(),new Date(row.shift_clock_out??now).getTime());
  return Math.max(0,end-start);
}
function sessionDurationInRange(row:Pick<SessionRow,"started_at"|"ended_at"|"shift_clock_in"|"shift_clock_out">,now:Date,rangeStart:number,rangeEnd:number){
  const start=Math.max(new Date(row.started_at).getTime(),new Date(row.shift_clock_in).getTime(),rangeStart);
  const end=Math.min(new Date(row.ended_at??now).getTime(),new Date(row.shift_clock_out??now).getTime(),rangeEnd);
  return Math.max(0,end-start);
}
function timestampInRange(value:string,rangeStart:number,rangeEnd:number){const timestamp=new Date(value).getTime();return timestamp>=rangeStart&&timestamp<rangeEnd}
function toIso(value:Timestamp){return value instanceof Date?value.toISOString():value}
function toIsoOrNull(value:Timestamp|null|undefined){return value==null?null:toIso(value)}
