"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { downloadWorkbook } from "@/lib/excel-workbook";
import { sanitizeEmployeeId } from "@/lib/timekeeping/employee-id";
import { timeApi } from "./api";
import { buildDailyTimelineRows, type DailyTimelineRow } from "./daily-timeline";
import { currentDate, formatClock, formatClockWithSeconds, formatDuration, stateLabel } from "./format";
import type { EmployeeReport } from "./types";
import { WaveChannelTag, WaveTypeTag } from "./wave-display";

type AttendanceEvent=EmployeeReport["attendanceEvents"][number];
type WorkProject=EmployeeReport["projects"][number];
type TimeEditTarget={target:"attendance"|"work_session";recordId:number;field:"clock_in"|"clock_out"|"started_at"|"ended_at";label:string;workDate:string;timestamp:string};
type TimeEditInput={item:TimeEditTarget;localTime:string;note:string};
type SaveResult={ok:boolean;message:string};
type AttendancePair={signIn:string;signOut:string|null;signInModified:boolean;signOutModified:boolean};

export default function RecordsPage({titleTarget,isAdmin,initialBadge}:{titleTarget:HTMLDivElement|null;isAdmin:boolean;initialBadge:string}){
  const [badge,setBadge]=useState(initialBadge);
  const [report,setReport]=useState<EmployeeReport|null>(null);
  const [error,setError]=useState("");
  const [pending,setPending]=useState(false);
  const [now,setNow]=useState(Date.now);
  const attemptedBadge=useRef("");
  const inputRef=useRef<HTMLInputElement>(null);

  const load=useCallback(async(nextBadge:string,period?:string)=>{
    const normalized=sanitizeEmployeeId(nextBadge);
    if(normalized.length!==8){setError("请扫描有效员工卡");return}
    attemptedBadge.current=normalized;
    setPending(true);
    setError("");
    try{
      const query=new URLSearchParams({badge:normalized});
      if(period)query.set("period",period);
      const next=await timeApi<EmployeeReport>(`/api/v1/timekeeping/records?${query.toString()}`);
      setReport(next);
      setBadge(normalized);
    }catch(loadError){
      setReport(null);
      setError(loadError instanceof Error?loadError.message:"工作记录读取失败");
    }finally{setPending(false)}
  },[]);

  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1_000);return()=>window.clearInterval(timer)},[]);
  useEffect(()=>{inputRef.current?.focus()},[titleTarget]);
  useEffect(()=>{
    const normalized=sanitizeEmployeeId(badge);
    if(normalized.length!==8||pending||attemptedBadge.current===normalized)return;
    const timer=window.setTimeout(()=>void load(normalized),420);
    return()=>window.clearTimeout(timer);
  },[badge,load,pending]);

  const saveTimeEdit=useCallback(async({item,localTime,note}:TimeEditInput):Promise<SaveResult>=>{
    if(!report)return {ok:false,message:"员工记录尚未载入"};
    try{
      await timeApi("/api/v1/timekeeping/records",{method:"PATCH",body:JSON.stringify({badge:report.snapshot.employee.badgeCode,requestId:crypto.randomUUID(),target:item.target,shiftId:item.target==="attendance"?item.recordId:undefined,sessionId:item.target==="work_session"?item.recordId:undefined,field:item.field,localTime,note,expectedOldTimestamp:item.timestamp})});
      await load(report.snapshot.employee.badgeCode,report.period.id);
      return {ok:true,message:"时间已修改"};
    }catch(saveError){return {ok:false,message:saveError instanceof Error?saveError.message:"时间修改失败"}}
  },[load,report]);

  const submit=(event:FormEvent)=>{event.preventDefault();void load(badge)};
  return <div className="time-page time-records-page">
    {titleTarget&&createPortal(<div className="time-record-titlebar time-no-print"><form onSubmit={submit}><div className="time-record-lookup-input"><span aria-hidden="true">⌁</span><input ref={inputRef} className="time-employee-id-entry" type="text" value={badge} onChange={event=>{attemptedBadge.current="";setBadge(sanitizeEmployeeId(event.target.value))}} maxLength={8} placeholder="扫描员工卡" aria-label="扫描员工卡" autoComplete="off" autoCapitalize="characters" spellCheck={false} data-1p-ignore="true" data-lpignore="true"/><b aria-live="polite">{pending?"识别中":"自动识别"}</b></div></form></div>,titleTarget)}
    {error&&<div className="time-error time-no-print">{error}<button onClick={()=>void load(badge)}>重试</button></div>}
    {!report&&!error&&<section className="time-card time-record-empty"><span>◎</span><b>请扫描员工卡</b><p>每页展示一个完整自然月。</p></section>}
    {report&&<EmployeeReportView key={`${report.snapshot.employee.badgeCode}-${report.period.id}`} report={report} now={now} loading={pending} isAdmin={isAdmin} onPeriodChange={period=>void load(report.snapshot.employee.badgeCode,period)} onTimeEdit={saveTimeEdit}/>}
  </div>;
}

function EmployeeReportView({report,now,loading,isAdmin,onPeriodChange,onTimeEdit}:{report:EmployeeReport;now:number;loading:boolean;isAdmin:boolean;onPeriodChange:(period:string)=>void;onTimeEdit:(input:TimeEditInput)=>Promise<SaveResult>}){
  const {snapshot}=report;
  const [selectedWorkDate,setSelectedWorkDate]=useState(report.defaultWorkDate);
  const [editingTarget,setEditingTarget]=useState<TimeEditTarget|null>(null);
  const [editTime,setEditTime]=useState("");
  const [editNote,setEditNote]=useState("");
  const [editSaving,setEditSaving]=useState(false);
  const [editNotice,setEditNotice]=useState<{ok:boolean;message:string}|null>(null);
  const attendancePairs=useMemo(()=>indexAttendancePairs(report.attendanceEvents),[report.attendanceEvents]);
  const monthDays=useMemo(()=>{
    const dayMap=new Map(report.days.map(day=>[day.workDate,day]));
    return inclusiveDateRange(report.period.startDate,report.period.endDate).map(workDate=>({workDate,day:dayMap.get(workDate)??null}));
  },[report.days,report.period.endDate,report.period.startDate]);

  const elapsed=Math.max(0,now-timestamp(report.generatedAt));
  const today=currentDate();
  const currentPeriodContainsToday=today>=report.period.startDate&&today<=report.period.endDate;
  const liveOnDutyMs=currentPeriodContainsToday&&["working","ready"].includes(snapshot.state)?elapsed:0;
  const firstHalfTotal=monthDays.reduce((sum,row)=>sum+(Number(row.workDate.slice(8,10))<=15?row.day?.onDutyMs??0:0),0)+(currentPeriodContainsToday&&Number(today.slice(8,10))<=15?liveOnDutyMs:0);
  const secondHalfTotal=monthDays.reduce((sum,row)=>sum+(Number(row.workDate.slice(8,10))>15?row.day?.onDutyMs??0:0),0)+(currentPeriodContainsToday&&Number(today.slice(8,10))>15?liveOnDutyMs:0);
  const periodTotal=report.period.totalMs+liveOnDutyMs;
  const dailyEdits=[
    ...report.attendanceEdits.filter(edit=>edit.workDate===selectedWorkDate).map(edit=>({id:`attendance-${edit.id}`,label:edit.label,oldTimestamp:edit.oldTimestamp,newTimestamp:edit.newTimestamp,note:edit.note,editor:edit.editor,editedAt:edit.editedAt})),
    ...report.workSessionEdits.filter(edit=>edit.workDate===selectedWorkDate).map(edit=>({id:`session-${edit.id}`,label:`${edit.workCode} · ${edit.label}`,oldTimestamp:edit.oldTimestamp,newTimestamp:edit.newTimestamp,note:edit.note,editor:edit.editor,editedAt:edit.editedAt})),
  ].toSorted((left,right)=>timestamp(right.editedAt)-timestamp(left.editedAt)||right.id.localeCompare(left.id));
  const timelineRows=buildDailyTimelineRows(report,selectedWorkDate,now);

  const selectWorkDate=(workDate:string)=>{setSelectedWorkDate(workDate);setEditingTarget(null);setEditNotice(null)};
  const openTimeEditor=(item:TimeEditTarget)=>{setEditingTarget(item);setEditTime(formatTimeInput(item.timestamp));setEditNote("");setEditNotice(null)};
  const openAttendanceEditor=(event:AttendanceEvent)=>openTimeEditor({target:"attendance",recordId:event.shiftId,field:event.field,label:event.label,workDate:event.workDate,timestamp:event.timestamp});
  const openWorkEditor=(project:WorkProject,field:"started_at"|"ended_at")=>{const value=field==="started_at"?project.startedAt:project.endedAt;if(value)openTimeEditor({target:"work_session",recordId:project.id,field,label:`${project.waveNo??project.name} · ${field==="started_at"?"开始时间":"结束时间"}`,workDate:project.workDate,timestamp:value})};
  const submitTimeEdit=async(event:FormEvent)=>{event.preventDefault();const note=editNote.trim();if(!editingTarget||!editTime||!note||editSaving)return;setEditSaving(true);const result=await onTimeEdit({item:editingTarget,localTime:editTime,note});setEditNotice(result);if(result.ok){setEditingTarget(null);setEditNote("")}setEditSaving(false)};
  const exportMonthlyPdf=()=>{const originalTitle=document.title;document.title=`${snapshot.employee.name}_${report.period.id}_考勤记录`;const restore=()=>{document.title=originalTitle};window.addEventListener("afterprint",restore,{once:true});window.print();window.setTimeout(restore,1_500)};

  return <section className="time-card time-record-report">
    <div className="time-record-report-head"><div className="time-record-identity"><span className="time-record-avatar">{snapshot.employee.name.slice(0,1)}</span><div><h2>{snapshot.employee.name}</h2><p>{snapshot.employee.type}</p></div></div><div className="time-record-report-actions time-no-print"><span className={`time-state ${snapshot.state}`}>{stateLabel(snapshot.state)}</span><button className="time-secondary" onClick={()=>void exportMonthlyTimeline(report,now)}>导出整月数据</button><button className="primary" onClick={exportMonthlyPdf}>导出整月 PDF</button></div></div>
    <div className="time-record-split">
      <section className="time-record-month">
        <div className="time-period-toolbar"><button disabled={loading} onClick={()=>onPeriodChange(report.period.previous)}>‹ 上一月</button><div><span>自然月记录</span><h3>{report.period.label}</h3><p>{prettyDateRange(report.period.startDate,report.period.endDate)}</p></div><button disabled={loading} onClick={()=>onPeriodChange(report.period.next)}>下一月 ›</button></div>
        <div className="time-period-summary"><div><strong>{report.period.workedDays}</strong><span>出勤天数</span></div><div><strong>{formatDuration(periodTotal)}</strong><span>本月总工时</span></div><div><strong>{formatDuration(firstHalfTotal)}</strong><span>上半月工时</span></div><div><strong>{formatDuration(secondHalfTotal)}</strong><span>下半月工时</span></div></div>
        <div className="time-attendance-period"><table aria-label="自然月在岗记录"><colgroup>{Array.from({length:6},(_,index)=><col key={index}/>)}</colgroup><thead><tr><th>日期</th><th>星期</th><th>首个 Sign In</th><th>最后 Sign Out</th><th>不在岗</th><th>在岗</th></tr></thead><tbody>{monthDays.map(row=>{
          const pairs=attendancePairs.get(row.workDate)??[];
          const firstPair=pairs[0];
          const lastPair=pairs.findLast(pair=>pair.signOut);
          const live=row.workDate===today?liveOnDutyMs:0;
          return <tr key={row.workDate} className={row.workDate===selectedWorkDate?"selected":""} onClick={()=>selectWorkDate(row.workDate)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectWorkDate(row.workDate)}}} tabIndex={0} aria-label={`查看${prettyWorkDate(row.workDate)}记录`} aria-selected={row.workDate===selectedWorkDate}><td><strong>{prettyMonthDay(row.workDate)}</strong></td><td>{prettyWeekday(row.workDate)}</td><td><span className={firstPair?.signInModified?"modified":""}>{firstPair?.signIn?formatClock(firstPair.signIn):""}</span></td><td><span className={lastPair?.signOutModified?"modified":""}>{lastPair?.signOut?formatClock(lastPair.signOut):""}</span></td><td>{row.day?formatDuration(row.day.offDutyMs):""}</td><td className="time-record-emphasis">{row.day?formatDuration(row.day.onDutyMs+live):""}</td></tr>;
        })}</tbody></table></div>
      </section>

      <section className="time-record-day">
        <div className="time-record-day-head"><div><span className="time-eyebrow">当天处理内容</span><h3>{prettyWorkDate(selectedWorkDate)}</h3></div></div>
        <div className="time-work-session-list">{timelineRows.length?<div className="time-work-session-table"><div className="time-work-session-header"><span>性质</span><span>波次号</span><span>内容</span><span>开始—结束</span><span>时长</span></div>{timelineRows.map(row=><div className={`time-work-session-row ${row.kind==="attendance"?"attendance":""}`} key={row.id}><strong>{row.nature}</strong><code>{row.waveNo}</code><TimelineContent row={row}/>{row.attendanceEvent&&isAdmin?<button type="button" className={row.attendanceEvent.modified?"modified":""} onClick={()=>openAttendanceEditor(row.attendanceEvent!)}>{row.clock}</button>:row.project&&isAdmin?<span className="time-editable-range"><button type="button" className={row.project.startedAtModified?"modified":""} onClick={()=>openWorkEditor(row.project!,"started_at")}>{formatClock(row.project.startedAt)}</button><i>–</i>{row.project.endedAt?<button type="button" className={row.project.endedAtModified?"modified":""} onClick={()=>openWorkEditor(row.project!,"ended_at")}>{formatClock(row.project.endedAt)}</button>:<em>进行中</em>}</span>:<span className="time-number">{row.clock}</span>}<b>{row.duration}</b></div>)}</div>:<div className="time-work-empty"><span>◎</span><strong>{prettyWorkDate(selectedWorkDate)} 没有考勤或工作记录</strong></div>}</div>
        {editingTarget&&<form className="time-attendance-edit-form" onSubmit={submitTimeEdit}><div><strong>修改 {editingTarget.label}</strong><span>{prettyWorkDate(editingTarget.workDate)} · 原时间 {formatClockWithSeconds(editingTarget.timestamp)}</span></div><label><span>新时间</span><input type="time" step="1" value={editTime} onChange={event=>setEditTime(event.target.value)} required/></label><label className="time-attendance-edit-note"><span>备注 *</span><input value={editNote} onChange={event=>setEditNote(event.target.value)} maxLength={300} placeholder="请填写修改原因" required/></label><div><button type="button" onClick={()=>setEditingTarget(null)} disabled={editSaving}>取消</button><button type="submit" disabled={editSaving||!editTime||!editNote.trim()}>{editSaving?"保存中…":"保存修改"}</button></div></form>}
        {editNotice&&<div className={`time-record-notice ${editNotice.ok?"success":"error"}`}>{editNotice.message}</div>}
        <section className="time-record-audit"><div className="time-record-audit-head"><div><span className="time-eyebrow">时间修改日志</span><h4>{prettyWorkDate(selectedWorkDate)}</h4></div><strong>{dailyEdits.length} 条</strong></div>{dailyEdits.length?<div className="time-record-audit-list">{dailyEdits.map(edit=><div key={edit.id}><strong title={edit.label}>{edit.label}</strong><span><del>{formatClockWithSeconds(edit.oldTimestamp)}</del> → <ins>{formatClockWithSeconds(edit.newTimestamp)}</ins></span><p title={edit.note}>{edit.note?`备注：${edit.note}`:"备注：未填写"}</p><small>{formatDetailedDateTime(edit.editedAt)} · {edit.editor}</small></div>)}</div>:<p className="time-record-audit-empty">当天没有时间修改记录。</p>}</section>
      </section>
    </div>
    <MonthlyPrintReport report={report} monthDays={monthDays} attendancePairs={attendancePairs} periodTotal={periodTotal} firstHalfTotal={firstHalfTotal} secondHalfTotal={secondHalfTotal} elapsed={elapsed} now={now}/>
  </section>;
}

function TimelineContent({row}:{row:DailyTimelineRow}){
  if(!row.project||row.project.workType!=="wave")return <span title={row.content}>{row.content}</span>;
  return <span className="time-record-wave-content" title={row.content}><WaveChannelTag value={row.project.channelName}/><WaveTypeTag value={row.project.channelType}/><span>{row.project.skuCount} SKU / {row.project.orderCount} 单 / {row.project.pieceCount} 件</span></span>;
}

function MonthlyPrintReport({report,monthDays,attendancePairs,periodTotal,firstHalfTotal,secondHalfTotal,elapsed,now}:{report:EmployeeReport;monthDays:Array<{workDate:string;day:EmployeeReport["days"][number]|null}>;attendancePairs:Map<string,AttendancePair[]>;periodTotal:number;firstHalfTotal:number;secondHalfTotal:number;elapsed:number;now:number}){
  const running=["working","ready"].includes(report.snapshot.state);
  return <section className="time-monthly-print-report" aria-label={`${report.period.label}整月考勤 PDF`}><header><div><span>内库 · 月度考勤记录</span><h1>{report.snapshot.employee.name}</h1></div><div><strong>{report.period.label}</strong></div></header><div className="time-monthly-print-summary"><span>出勤天数 <strong>{report.period.workedDays}</strong></span><span>本月总工时 <strong>{formatDuration(periodTotal)}</strong></span><span>上半月工时 <strong>{formatDuration(firstHalfTotal)}</strong></span><span>下半月工时 <strong>{formatDuration(secondHalfTotal)}</strong></span></div><table><thead><tr><th>日期</th><th>星期</th><th>首个 Sign In</th><th>最后 Sign Out</th><th>不在岗</th><th>在岗</th></tr></thead><tbody>{monthDays.map(row=>{const pairs=attendancePairs.get(row.workDate)??[];const firstPair=pairs[0];const lastPair=pairs.findLast(pair=>pair.signOut);return <tr key={row.workDate}><td>{prettyMonthDay(row.workDate)}</td><td>{prettyWeekday(row.workDate)}</td><td className={firstPair?.signInModified?"modified":""}>{firstPair?.signIn?<>{formatClockWithSeconds(firstPair.signIn)}{firstPair.signInModified&&<sup>*</sup>}</>:""}</td><td className={lastPair?.signOutModified?"modified":""}>{lastPair?.signOut?<>{formatClockWithSeconds(lastPair.signOut)}{lastPair.signOutModified&&<sup>*</sup>}</>:""}</td><td>{row.day?formatDuration(row.day.offDutyMs):""}</td><td>{row.day?formatDuration(row.day.onDutyMs+(row.workDate===currentDate()&&running?elapsed:0)):""}</td></tr>})}</tbody></table><footer>* 表示该考勤时间曾被修改 · 导出时间 {formatDetailedDateTime(new Date(now).toISOString())}</footer></section>;
}

function indexAttendancePairs(events:EmployeeReport["attendanceEvents"]){
  const byDate=new Map<string,AttendancePair[]>();
  for(const event of [...events].sort((left,right)=>timestamp(left.timestamp)-timestamp(right.timestamp))){
    const pairs=byDate.get(event.workDate)??[];
    if(event.type==="sign_in")pairs.push({signIn:event.timestamp,signOut:null,signInModified:event.modified,signOutModified:false});
    else{const openPair=[...pairs].reverse().find(pair=>pair.signOut===null);if(openPair){openPair.signOut=event.timestamp;openPair.signOutModified=event.modified}}
    byDate.set(event.workDate,pairs);
  }
  return byDate;
}

async function exportMonthlyTimeline(report:EmployeeReport,now:number){
  const editsByEvent=new Map<string,EmployeeReport["attendanceEdits"]>();
  for(const edit of report.attendanceEdits){const key=`${edit.shiftId}:${edit.field}`;const edits=editsByEvent.get(key)??[];edits.push(edit);editsByEvent.set(key,edits)}
  const editsBySession=new Map<number,EmployeeReport["workSessionEdits"]>();
  for(const edit of report.workSessionEdits){const edits=editsBySession.get(edit.sessionId)??[];edits.push(edit);editsBySession.set(edit.sessionId,edits)}
  const rows:Array<{timestamp:string;values:Array<string|number>}>= [
    ...report.attendanceEvents.map(event=>{
      const edits=(editsByEvent.get(`${event.shiftId}:${event.field}`)??[]).toSorted((left,right)=>timestamp(left.editedAt)-timestamp(right.editedAt)||left.id-right.id);
      return {timestamp:event.timestamp,values:[event.workDate,prettyWeekday(event.workDate),"考勤",event.label,"","","","",formatDetailedDateTime(event.timestamp),"","","","","",event.modified?"已修改":"",edits.map((edit,index)=>`修改${index+1}：${formatDetailedDateTime(edit.editedAt)}｜${formatClockWithSeconds(edit.oldTimestamp)} → ${formatClockWithSeconds(edit.newTimestamp)}｜${edit.editor}｜备注：${edit.note}`).join("\n")]};
    }),
    ...report.projects.map(project=>{const edits=(editsBySession.get(project.id)??[]).toSorted((left,right)=>timestamp(left.editedAt)-timestamp(right.editedAt)||left.id-right.id);return {
      timestamp:project.startedAt,
      values:[project.workDate,prettyWeekday(project.workDate),project.workType==="wave"?"波次":"日常",project.name,project.code,project.waveNo??"",project.workType==="wave"?project.channelName:"",project.workType==="wave"?project.channelType:"",formatDetailedDateTime(project.startedAt),project.endedAt?formatDetailedDateTime(project.endedAt):"",formatDuration(project.totalMs+(!project.endedAt&&report.snapshot.state==="working"?Math.max(0,now-timestamp(report.generatedAt)):0)),project.workType==="wave"?project.skuCount:"",project.workType==="wave"?project.orderCount:"",project.workType==="wave"?project.pieceCount:"",edits.length?"已修改":"",[...edits.map((edit,index)=>`修改${index+1}：${edit.label}｜${formatDetailedDateTime(edit.editedAt)}｜${formatClockWithSeconds(edit.oldTimestamp)} → ${formatClockWithSeconds(edit.newTimestamp)}｜${edit.editor}｜备注：${edit.note}`),...(!project.endedAt?[`进行中；数据截至 ${formatDetailedDateTime(new Date(now).toISOString())}`]:[])].join("\n")],
    }}),
  ].toSorted((left,right)=>timestamp(left.timestamp)-timestamp(right.timestamp));
  const employee=report.snapshot.employee;
  const headers=["序号","姓名","员工类型","日期","星期","性质","事件 / 工作","工作代码","波次号","渠道","波次类型","开始时间","结束时间","时长","SKU","订单","拣货","修改","备注"];
  await downloadWorkbook({fileName:`${safeFileName(employee.name)}_${report.period.id}_整月时间轴.xlsx`,sheets:[{sheetName:"整月时间轴",rows:[headers,...rows.map((row,index)=>[index+1,employee.name,employee.type,...row.values])],widths:[6,14,10,12,9,9,22,18,22,13,13,21,21,14,8,8,8,10,52],autoFilter:`A1:S${rows.length+1}`}]});
}

function inclusiveDateRange(startDate:string,endDate:string){const dates:string[]=[];const current=new Date(`${startDate}T00:00:00Z`);const end=new Date(`${endDate}T00:00:00Z`);while(current<=end){dates.push(current.toISOString().slice(0,10));current.setUTCDate(current.getUTCDate()+1)}return dates}
function timestamp(value:string){return new Date(value).getTime()}
function prettyWorkDate(date:string){return new Intl.DateTimeFormat("zh-CN",{month:"short",day:"numeric",weekday:"short"}).format(new Date(`${date}T12:00:00`))}
function prettyMonthDay(date:string){return `${date.slice(5,7)}月${date.slice(8,10)}日`}
function prettyWeekday(date:string){return new Intl.DateTimeFormat("zh-CN",{weekday:"long"}).format(new Date(`${date}T12:00:00`))}
function prettyDateRange(start:string,end:string){return `${start.replaceAll("-",".")} — ${end.replaceAll("-",".")}`}
function formatDetailedDateTime(value:string){return new Intl.DateTimeFormat("zh-CN",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date(value))}
function formatTimeInput(value:string){const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value)).map(part=>[part.type,part.value]));return `${parts.hour}:${parts.minute}:${parts.second}`}
function safeFileName(value:string){return value.replace(/[\\/:*?"<>|]+/g,"-")}
