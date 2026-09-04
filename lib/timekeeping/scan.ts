import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { getDb } from "../../db";
import { ensureTimekeepingSchema } from "../../db/timekeeping-runtime";
import { timeEmployees,timeScanEvents,timeShifts,timeWaveAssignments,timeWorkItems,timeWorkSessions } from "../../db/timekeeping-schema";
import type { InternalUser } from "../internal-auth";
import { getEmployeeSnapshot, lockTimekeeping, reconcileStaleOpenShifts, recordTimeRevision, type TimeTransaction } from "./data";
import { workDate } from "./time";

type Tone="success"|"info"|"warning"|"error";
type ScanResponse={ok:boolean;event:string;message:string;tone:Tone;duplicate?:boolean;employeeId?:number;snapshot?:NonNullable<Awaited<ReturnType<typeof getEmployeeSnapshot>>>;contextExpiresAt?:number};
export type ScanInput={code?:unknown;projectCode?:unknown;completeProjectId?:unknown;employeeId?:unknown;requestId?:unknown;terminalId?:unknown};
type WorkItem=typeof timeWorkItems.$inferSelect;

const ACTIONS:Record<string,"CLOCKIN"|"OUT">={"ACT-CLOCKIN":"CLOCKIN","ACT-OUT":"OUT",OUT:"OUT","下班":"OUT"};

export async function performScan(user:InternalUser,input:ScanInput){
  await ensureTimekeepingSchema();
  await reconcileStaleOpenShifts();
  const code=cleanCode(input.code);
  const projectCode=cleanCode(input.projectCode);
  const hasCompletion=input.completeProjectId!==undefined&&input.completeProjectId!==null;
  const completeProjectId=Number(input.completeProjectId);
  const requestedEmployeeId=Number(input.employeeId);
  const requestId=String(input.requestId??crypto.randomUUID()).trim().slice(0,96);
  const terminalId=String(input.terminalId??"kiosk-main").trim().slice(0,64)||"kiosk-main";
  if(!code)return {status:400,response:{ok:false,event:"EMPTY_CODE",message:"扫描内容不能为空",tone:"warning" as const}};
  if(!requestId)return {status:400,response:{ok:false,event:"INVALID_REQUEST",message:"扫描请求编号无效",tone:"warning" as const}};
  if(hasCompletion&&(!Number.isInteger(completeProjectId)||completeProjectId<1))return {status:400,response:{ok:false,event:"INVALID_WAVE",message:"待完结波次无效",tone:"warning" as const}};

  return getDb().transaction(async tx=>{
    await lockTimekeeping(tx);
    const previous=(await tx.select({payload:timeScanEvents.responsePayload}).from(timeScanEvents).where(eq(timeScanEvents.id,requestId)).limit(1))[0];
    if(previous)return {status:200,response:{...(previous.payload as ScanResponse),duplicate:true}};

    const employeeByBadge=(await tx.select().from(timeEmployees).where(and(or(eq(timeEmployees.employeeCode,code),eq(timeEmployees.badgeCode,code)),eq(timeEmployees.active,true))).limit(1))[0];
    if(employeeByBadge){
      const duplicate=await recentDuplicate(tx,terminalId,employeeByBadge.id,code);
      if(duplicate)return {status:200,response:{...duplicate,duplicate:true}};
      const snapshot=await getEmployeeSnapshot(employeeByBadge.id,tx);
      if(!snapshot)throw new Error("员工记录已不存在");
      const response:ScanResponse={ok:true,event:snapshot.shift?"IDENTIFIED":"CLOCK_IN_PENDING",message:snapshot.shift?`${employeeByBadge.name} 已识别 · ${snapshot.state==="working"?`正在处理 ${snapshot.currentProject?.code}`:snapshot.currentProject?.workType==="standard"?`${snapshot.currentProject.code} 计时已暂停`:"在岗 · 当前无任务"}`:`${employeeByBadge.name} 已识别 · 当前不在岗${snapshot.currentProject?.workType==="standard"?` · 固定任务 ${snapshot.currentProject.code} 计时已暂停`:snapshot.currentProject?` · 挂载波次 ${snapshot.currentProject.waveNo??snapshot.currentProject.code}`:" · 无挂载任务"}`,tone:"info",employeeId:employeeByBadge.id,snapshot,contextExpiresAt:Date.now()+90_000};
      await recordEvent(tx,user,requestId,terminalId,employeeByBadge.id,snapshot.currentProject?.id??null,code,response);
      return {status:200,response};
    }

    if(!Number.isInteger(requestedEmployeeId)||requestedEmployeeId<1){
      const response:ScanResponse={ok:false,event:"EMPLOYEE_REQUIRED",message:"员工 ID 未识别，本次操作未执行",tone:"warning"};
      await recordEvent(tx,user,requestId,terminalId,null,null,code,response);
      return {status:409,response};
    }
    const duplicate=await recentDuplicate(tx,terminalId,requestedEmployeeId,code);
    if(duplicate)return {status:200,response:{...duplicate,duplicate:true}};
    const snapshot=await getEmployeeSnapshot(requestedEmployeeId,tx);
    if(!snapshot||!snapshot.employee.active){
      const response:ScanResponse={ok:false,event:"EMPLOYEE_INACTIVE",message:"找不到员工或员工已停用",tone:"warning",employeeId:requestedEmployeeId};
      await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,null,code,response);
      return {status:404,response};
    }
    const action=ACTIONS[code];
    if(!snapshot.shift){
      if(action!=="CLOCKIN")return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,null,"SHIFT_REQUIRED","员工当前不在岗，本次操作未执行",snapshot,409);
      const preferred=projectCode
        ?await findActiveWorkItem(tx,projectCode)
        :snapshot.currentProject
          ?await findActiveWorkItem(tx,snapshot.currentProject.code)
          :snapshot.employee.defaultWorkItemId
            ?await findDefaultWorkItem(tx,snapshot.employee.defaultWorkItemId)
            :null;
      const resuming=Boolean(!projectCode&&preferred&&snapshot.currentProject?.id===preferred.id);
      if(projectCode&&!preferred)return reject(tx,user,requestId,terminalId,projectCode,requestedEmployeeId,null,"UNKNOWN_CODE",`无法识别任务 ${projectCode}`,snapshot,404);
      if(preferred){
        const leadConflict=await findLeadWave(tx,requestedEmployeeId,preferred.id);
        if(leadConflict)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,leadConflict.id,"LEAD_TASK_LOCKED",`该员工是波次 ${leadConflict.waveNo} 的主负责人，完结前不能切换任务`,snapshot,409);
      }
      const now=new Date().toISOString();
      const [shift]=await tx.insert(timeShifts).values({employeeId:requestedEmployeeId,workDate:workDate(now),clockIn:now,status:"open",createdAt:now}).returning();
      if(preferred)await startWork(tx,shift.id,requestedEmployeeId,preferred,now);
      await recordTimeRevision(tx);
      const next=await getEmployeeSnapshot(requestedEmployeeId,tx);
      const response:ScanResponse={ok:true,event:preferred?(resuming?"CLOCK_IN_PROJECT_RESUME":"CLOCK_IN_PROJECT_START"):"CLOCK_IN",message:preferred?`${snapshot.employee.name} Sign In 成功 · ${preferred.code} · ${preferred.name} ${resuming?"继续计时":"开始计时"}`:`${snapshot.employee.name}，Sign In 成功，当前尚未分配工作`,tone:"success",employeeId:requestedEmployeeId,snapshot:next??undefined,contextExpiresAt:Date.now()+90_000};
      await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,preferred?.id??null,code,response);
      return {status:200,response};
    }

    if(action==="CLOCKIN"){
      const response:ScanResponse={ok:true,event:"ALREADY_CLOCKED_IN",message:"员工已经开工，重复确认已忽略",tone:"info",employeeId:requestedEmployeeId,snapshot};
      await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,snapshot.currentProject?.id??null,code,response);
      return {status:200,response};
    }

    if(action==="OUT"){
      let completed:WorkItem|null=null;
      if(hasCompletion){const completion=await validateCompletion(tx,requestedEmployeeId,completeProjectId);if(!completion.ok)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,completeProjectId,"WAVE_COMPLETE_REJECTED",completion.error,snapshot,409);completed=completion.item;await completeWave(tx,completion.item.id)}
      const pausedStandard=snapshot.currentProject?.workType==="standard"?snapshot.currentProject:null;
      const now=new Date().toISOString();
      await tx.update(timeWorkSessions).set({endedAt:now}).where(and(eq(timeWorkSessions.employeeId,requestedEmployeeId),isNull(timeWorkSessions.endedAt)));
      await tx.update(timeShifts).set({clockOut:now,status:"closed"}).where(eq(timeShifts.id,snapshot.shift.id));
      await recordTimeRevision(tx);
      const next=await getEmployeeSnapshot(requestedEmployeeId,tx);
      const pausedProject=snapshot.currentProject;
      const response:ScanResponse={ok:true,event:completed?"WAVE_COMPLETE_CLOCK_OUT":"CLOCK_OUT",message:completed?`${snapshot.employee.name} · 波次 ${completed.waveNo} 已完结，计时已结束 · Sign Out 成功`:pausedProject?`${snapshot.employee.name}，Sign Out 成功 · ${pausedProject.waveNo??pausedProject.code} 计时已暂停${pausedStandard?"，今天再次 Sign In 后继续":""}`:`${snapshot.employee.name}，Sign Out 成功`,tone:"success",employeeId:requestedEmployeeId,snapshot:next??undefined,contextExpiresAt:Date.now()+8_000};
      await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,completed?.id??snapshot.currentProject?.id??null,code,response);
      return {status:200,response};
    }

    if(hasCompletion&&code==="ACT-WAVE-COMPLETE"){
      const completion=await validateCompletion(tx,requestedEmployeeId,completeProjectId);
      if(!completion.ok)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,completeProjectId,"WAVE_COMPLETE_REJECTED",completion.error,snapshot,409);
      await completeWave(tx,completion.item.id);await recordTimeRevision(tx);
      const next=await getEmployeeSnapshot(requestedEmployeeId,tx);
      const response:ScanResponse={ok:true,event:"WAVE_COMPLETE",message:`${snapshot.employee.name} · 波次 ${completion.item.waveNo} 已完结，计时已结束`,tone:"success",employeeId:requestedEmployeeId,snapshot:next??undefined,contextExpiresAt:Date.now()+45_000};
      await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,completion.item.id,code,response);return {status:200,response};
    }

    const item=await findActiveWorkItem(tx,code);
    if(!item)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,null,"UNKNOWN_CODE",`无法识别条码 ${code}`,snapshot,404);
    let completedBeforeSwitch:WorkItem|null=null;
    if(hasCompletion){
      const completion=await validateCompletion(tx,requestedEmployeeId,completeProjectId);
      if(!completion.ok)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,completeProjectId,"WAVE_COMPLETE_REJECTED",completion.error,snapshot,409);
      if(completion.item.id===item.id)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,item.id,"WAVE_SWITCH_SAME_PROJECT","待完结波次不能同时作为下一个波次",snapshot,409);
      await completeWave(tx,completion.item.id);
      completedBeforeSwitch=completion.item;
    }
    const leadConflict=await findLeadWave(tx,requestedEmployeeId,item.id);
    if(leadConflict)return reject(tx,user,requestId,terminalId,code,requestedEmployeeId,item.id,"LEAD_TASK_LOCKED",`该员工是波次 ${leadConflict.waveNo} 的主负责人，完结前不能切换任务`,snapshot,409);
    if(snapshot.currentProject?.id===item.id){const response:ScanResponse={ok:true,event:"PROJECT_UNCHANGED",message:`${item.code} 已在计时，重复扫描已忽略`,tone:"info",employeeId:requestedEmployeeId,snapshot};await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,item.id,code,response);return {status:200,response}}
    const now=new Date().toISOString();
    await tx.update(timeWorkSessions).set({endedAt:now}).where(and(eq(timeWorkSessions.employeeId,requestedEmployeeId),isNull(timeWorkSessions.endedAt)));
    await startWork(tx,snapshot.shift.id,requestedEmployeeId,item,now);await recordTimeRevision(tx);
    const next=await getEmployeeSnapshot(requestedEmployeeId,tx);
    const response:ScanResponse={ok:true,event:completedBeforeSwitch?"WAVE_COMPLETE_PROJECT_START":"PROJECT_START",message:completedBeforeSwitch?`${snapshot.employee.name} · 波次 ${completedBeforeSwitch.waveNo??completedBeforeSwitch.code} 已完结，计时已结束 · ${item.code} · ${item.name} 开始计时`:snapshot.currentProject?`${snapshot.employee.name} 任务 ${snapshot.currentProject.waveNo??snapshot.currentProject.name} → ${item.code} · ${item.name} · 新任务开始计时`:`${snapshot.employee.name} ${item.code} · ${item.name} 开始计时`,tone:"success",employeeId:requestedEmployeeId,snapshot:next??undefined,contextExpiresAt:Date.now()+45_000};
    await recordEvent(tx,user,requestId,terminalId,requestedEmployeeId,item.id,code,response);return {status:200,response};
  });
}

async function findActiveWorkItem(tx:TimeTransaction,code:string){return (await tx.select().from(timeWorkItems).where(and(or(eq(timeWorkItems.barcode,code),eq(timeWorkItems.code,code),eq(timeWorkItems.waveNo,code)),eq(timeWorkItems.status,"active"))).limit(1))[0]??null}
async function findDefaultWorkItem(tx:TimeTransaction,id:number){return (await tx.select().from(timeWorkItems).where(and(eq(timeWorkItems.id,id),eq(timeWorkItems.workType,"standard"),eq(timeWorkItems.status,"active"))).limit(1))[0]??null}
async function findLeadWave(tx:TimeTransaction,employeeId:number,exceptId:number){return (await tx.select({id:timeWorkItems.id,waveNo:timeWorkItems.waveNo}).from(timeWaveAssignments).innerJoin(timeWorkItems,eq(timeWaveAssignments.workItemId,timeWorkItems.id)).where(and(eq(timeWaveAssignments.employeeId,employeeId),eq(timeWaveAssignments.role,"lead"),eq(timeWorkItems.status,"active"),isNull(timeWorkItems.interruptedAt),ne(timeWorkItems.id,exceptId))).limit(1))[0]??null}
async function startWork(tx:TimeTransaction,shiftId:number,employeeId:number,item:WorkItem,now:string){
  if(item.workType==="wave"){
    const own=await tx.select({id:timeWaveAssignments.id}).from(timeWaveAssignments).where(and(eq(timeWaveAssignments.workItemId,item.id),eq(timeWaveAssignments.employeeId,employeeId))).limit(1);
    if(!own.length){const lead=await tx.select({id:timeWaveAssignments.id}).from(timeWaveAssignments).where(and(eq(timeWaveAssignments.workItemId,item.id),eq(timeWaveAssignments.role,"lead"))).limit(1);await tx.insert(timeWaveAssignments).values({workItemId:item.id,employeeId,role:lead.length?"helper":"lead",assignedAt:now})}
    if(item.interruptedAt)await tx.update(timeWorkItems).set({interruptedAt:null}).where(eq(timeWorkItems.id,item.id));
  }
  await tx.insert(timeWorkSessions).values({shiftId,employeeId,workItemId:item.id,startedAt:now});
}
async function validateCompletion(tx:TimeTransaction,employeeId:number,itemId:number):Promise<{ok:true;item:WorkItem}|{ok:false;error:string}>{const item=(await tx.select().from(timeWorkItems).where(and(eq(timeWorkItems.id,itemId),eq(timeWorkItems.workType,"wave"),eq(timeWorkItems.status,"active"))).limit(1))[0];if(!item)return {ok:false,error:"待完结波次不存在或已完结"};const lead=await tx.select({id:timeWaveAssignments.id}).from(timeWaveAssignments).where(and(eq(timeWaveAssignments.workItemId,itemId),eq(timeWaveAssignments.employeeId,employeeId),eq(timeWaveAssignments.role,"lead"))).limit(1);return lead.length?{ok:true,item}:{ok:false,error:"只有波次主负责人可以完结波次"}}
async function completeWave(tx:TimeTransaction,itemId:number){const now=new Date().toISOString();await tx.update(timeWorkSessions).set({endedAt:now}).where(and(eq(timeWorkSessions.workItemId,itemId),isNull(timeWorkSessions.endedAt)));await tx.update(timeWorkItems).set({status:"completed",completedAt:now,interruptedAt:null}).where(eq(timeWorkItems.id,itemId))}
async function recentDuplicate(tx:TimeTransaction,terminalId:string,employeeId:number,code:string){const row=(await tx.select({payload:timeScanEvents.responsePayload}).from(timeScanEvents).where(and(eq(timeScanEvents.terminalId,terminalId),eq(timeScanEvents.employeeId,employeeId),eq(timeScanEvents.scannedCode,code),gt(timeScanEvents.occurredAt,new Date(Date.now()-2000).toISOString()))).limit(1))[0];return row?.payload as ScanResponse|undefined}
async function reject(tx:TimeTransaction,user:InternalUser,id:string,terminalId:string,code:string,employeeId:number,workItemId:number|null,event:string,message:string,snapshot:NonNullable<Awaited<ReturnType<typeof getEmployeeSnapshot>>>,status:number){const response:ScanResponse={ok:false,event,message,tone:"warning",employeeId,snapshot};await recordEvent(tx,user,id,terminalId,employeeId,workItemId,code,response);return {status,response}}
async function recordEvent(tx:TimeTransaction,user:InternalUser,id:string,terminalId:string,employeeId:number|null,workItemId:number|null,code:string,response:ScanResponse){await tx.insert(timeScanEvents).values({id,terminalId,operatorUserId:user.id,operatorUsername:user.username,employeeId,workItemId,scannedCode:code,eventType:response.event,outcome:response.ok?"ok":"rejected",responsePayload:response,occurredAt:new Date().toISOString()})}
function cleanCode(value:unknown){return String(value??"").normalize("NFKC").trim().toUpperCase().slice(0,64)}
