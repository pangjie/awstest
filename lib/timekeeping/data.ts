import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { ensureTimekeepingSchema } from "../../db/timekeeping-runtime";
import { timeEmployees,timeRevisions,timeShifts,timeWaveAssignments,timeWorkItems,timeWorkSessions } from "../../db/timekeeping-schema";
import { addDays, localDateTimeToIso, workDate } from "./time";

type Database=ReturnType<typeof getDb>;
export type TimeTransaction=Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function lockTimekeeping(tx:TimeTransaction){await tx.execute(sql`SELECT pg_advisory_xact_lock(7320250830)`)}
export async function recordTimeRevision(tx:TimeTransaction){await tx.insert(timeRevisions).values({changedAt:new Date().toISOString()})}
export async function getTimeRevision(){await ensureTimekeepingSchema();const row=(await getDb().select({id:sql<number>`COALESCE(MAX(${timeRevisions.id}),0)`}).from(timeRevisions))[0];return Number(row?.id??0)}

export async function reconcileStaleOpenShifts(now=new Date()){
  await ensureTimekeepingSchema();
  const today=workDate(now);
  return getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const stale=await tx.select().from(timeShifts).where(and(eq(timeShifts.status,"open"),ne(timeShifts.workDate,today))).orderBy(timeShifts.clockIn);
    if(!stale.length)return 0;
    for(const shift of stale){
      const midnight=new Date(localDateTimeToIso(`${addDays(shift.workDate,1)}T00:00`)).getTime()-1;
      const clockIn=new Date(shift.clockIn).getTime();
      const safeEnd=new Date(Math.max(clockIn,Math.min(now.getTime(),midnight,clockIn+16*60*60*1000))).toISOString();
      await tx.update(timeWorkSessions).set({endedAt:safeEnd}).where(and(eq(timeWorkSessions.shiftId,shift.id),isNull(timeWorkSessions.endedAt)));
      await tx.update(timeShifts).set({clockOut:safeEnd,status:"closed"}).where(eq(timeShifts.id,shift.id));
    }
    await recordTimeRevision(tx);
    return stale.length;
  });
}

export async function getEmployeeSnapshot(identifier:number|string,db:Pick<Database,"select">=getDb()){
  await ensureTimekeepingSchema();
  const employee=typeof identifier==="number"
    ?(await db.select().from(timeEmployees).where(eq(timeEmployees.id,identifier)).limit(1))[0]
    :(await db.select().from(timeEmployees).where(or(eq(timeEmployees.employeeCode,identifier),eq(timeEmployees.badgeCode,identifier))).limit(1))[0];
  if(!employee)return null;
  const today=workDate();
  const todayShifts=await db.select().from(timeShifts).where(and(eq(timeShifts.employeeId,employee.id),eq(timeShifts.workDate,today))).orderBy(desc(timeShifts.clockIn));
  const shift=todayShifts.find(item=>item.status==="open")??null;
  const activeSession=shift?(await db.select({id:timeWorkSessions.id,startedAt:timeWorkSessions.startedAt,workItemId:timeWorkItems.id,code:timeWorkItems.code,name:timeWorkItems.name,workType:timeWorkItems.workType,waveNo:timeWorkItems.waveNo,status:timeWorkItems.status,role:timeWaveAssignments.role})
    .from(timeWorkSessions).innerJoin(timeWorkItems,eq(timeWorkSessions.workItemId,timeWorkItems.id))
    .leftJoin(timeWaveAssignments,and(eq(timeWaveAssignments.workItemId,timeWorkItems.id),eq(timeWaveAssignments.employeeId,employee.id)))
    .where(and(eq(timeWorkSessions.employeeId,employee.id),isNull(timeWorkSessions.endedAt))).limit(1))[0]??null:null;
  const latestTodaySession=!activeSession?(await db.select({id:timeWorkSessions.id,startedAt:timeWorkSessions.startedAt,workItemId:timeWorkItems.id,code:timeWorkItems.code,name:timeWorkItems.name,workType:timeWorkItems.workType,waveNo:timeWorkItems.waveNo,status:timeWorkItems.status,role:timeWaveAssignments.role})
    .from(timeWorkSessions).innerJoin(timeWorkItems,eq(timeWorkSessions.workItemId,timeWorkItems.id))
    .innerJoin(timeShifts,eq(timeWorkSessions.shiftId,timeShifts.id))
    .leftJoin(timeWaveAssignments,and(eq(timeWaveAssignments.workItemId,timeWorkItems.id),eq(timeWaveAssignments.employeeId,employee.id)))
    .where(and(eq(timeWorkSessions.employeeId,employee.id),eq(timeShifts.workDate,today))).orderBy(desc(timeWorkSessions.startedAt),desc(timeWorkSessions.id)).limit(1))[0]??null:null;
  const pausedStandard=latestTodaySession?.workType==="standard"&&latestTodaySession.status==="active"?latestTodaySession:null;
  const attachedWave=!shift&&!pausedStandard?(await db.select({id:timeWorkSessions.id,startedAt:timeWorkSessions.startedAt,workItemId:timeWorkItems.id,code:timeWorkItems.code,name:timeWorkItems.name,workType:timeWorkItems.workType,waveNo:timeWorkItems.waveNo,status:timeWorkItems.status,role:timeWaveAssignments.role})
    .from(timeWorkSessions).innerJoin(timeWorkItems,eq(timeWorkSessions.workItemId,timeWorkItems.id))
    .leftJoin(timeWaveAssignments,and(eq(timeWaveAssignments.workItemId,timeWorkItems.id),eq(timeWaveAssignments.employeeId,employee.id)))
    .where(and(eq(timeWorkSessions.employeeId,employee.id),eq(timeWorkItems.workType,"wave"),eq(timeWorkItems.status,"active"))).orderBy(desc(timeWorkSessions.startedAt)).limit(1))[0]??null:null;
  const currentProject=activeSession??pausedStandard??attachedWave;
  const now=Date.now();
  const onDutyMs=todayShifts.reduce((total,item)=>total+Math.max(0,new Date(item.clockOut??now).getTime()-new Date(item.clockIn).getTime()),0);
  const sessions=await db.select({startedAt:timeWorkSessions.startedAt,endedAt:timeWorkSessions.endedAt,shiftClockIn:timeShifts.clockIn,shiftClockOut:timeShifts.clockOut})
    .from(timeWorkSessions).innerJoin(timeShifts,eq(timeWorkSessions.shiftId,timeShifts.id))
    .where(and(eq(timeWorkSessions.employeeId,employee.id),eq(timeShifts.workDate,today)));
  const productiveMs=sessions.reduce((total,item)=>{
    const start=Math.max(new Date(item.startedAt).getTime(),new Date(item.shiftClockIn).getTime());
    const end=Math.min(new Date(item.endedAt??now).getTime(),new Date(item.shiftClockOut??now).getTime());
    return total+Math.max(0,end-start);
  },0);
  const firstIn=todayShifts.length?Math.min(...todayShifts.map(item=>new Date(item.clockIn).getTime())):null;
  const attendanceEnd=shift?now:todayShifts.length?Math.max(...todayShifts.map(item=>new Date(item.clockOut??item.clockIn).getTime())):now;
  const state=!employee.active?"inactive":shift?(activeSession?"working":"ready"):todayShifts.length?"off":"not_started";
  return {
    employee:{id:employee.id,badgeCode:employee.employeeCode??employee.badgeCode,name:employee.name,type:employee.organizationType,active:employee.active,defaultWorkItemId:employee.defaultWorkItemId},
    state,
    shift:shift?{id:shift.id,workDate:shift.workDate,clockIn:shift.clockIn,clockOut:shift.clockOut}:null,
    currentProject:currentProject?{id:currentProject.workItemId,code:currentProject.code,name:currentProject.name,workType:currentProject.workType,waveNo:currentProject.waveNo,status:currentProject.status,assignmentRole:currentProject.role??null,startedAt:currentProject.startedAt}:null,
    today:{onDutyMs,productiveMs,offDutyMs:firstIn===null?0:Math.max(0,attendanceEnd-firstIn-onDutyMs)},
  };
}
