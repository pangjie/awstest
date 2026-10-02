"use client";
import { t, useLanguage, taskText, durationText } from "@/app/ui-language";

import { FormEvent, useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { downloadWorkbook } from "@/lib/excel-workbook";
import { timeApi } from "./api";
import { currentDate, formatClock, formatClockWithSeconds, formatDuration, stateLabel } from "./format";
import type { AttendanceExportResponse, AttendanceExportScope, EmployeeRecord, EmployeeSortKey, EmployeeSortState, EmployeesResponse } from "./types";

export default function EmployeesPage({titleTarget,isAdmin,openRecords,openScan,sortState,setSortState}:{titleTarget:HTMLDivElement|null;isAdmin:boolean;openRecords?:((badge:string)=>void);openScan?:((badge:string)=>void);sortState:EmployeeSortState;setSortState:Dispatch<SetStateAction<EmployeeSortState>>}){
  useLanguage();
  const [data,setData]=useState<EmployeesResponse|null>(null);
  const [query,setQuery]=useState("");
  const [status,setStatus]=useState("active");
  const {key:sort,descending}=sortState;
  const [adding,setAdding]=useState(false);
  const [editing,setEditing]=useState<EmployeeRecord|null>(null);
  const [attendanceExportOpen,setAttendanceExportOpen]=useState(false);
  const [pendingAction,setPendingAction]=useState<string|null>(null);
  const [exporting,setExporting]=useState(false);
  const [error,setError]=useState("");
  const load=useCallback(async()=>{try{setData(await timeApi<EmployeesResponse>("/api/v1/timekeeping/employees"));setError("")}catch(loadError){setError(loadError instanceof Error?loadError.message:"员工数据读取失败")}},[]);
  useEffect(()=>{let cancelled=false;void timeApi<EmployeesResponse>("/api/v1/timekeeping/employees").then(next=>{if(!cancelled){setData(next);setError("")}}).catch(loadError=>{if(!cancelled)setError(loadError instanceof Error?loadError.message:"员工数据读取失败")});return()=>{cancelled=true}},[]);
  const rows=useMemo(()=>{
    const needle=query.trim().toLowerCase();
    return (data?.employees??[]).filter(row=>(status==="all"||status==="active"&&row.active||status==="inactive"&&!row.active)&&(!needle||`${row.badgeCode} ${row.name} ${row.type} ${row.defaultWorkItem?.code??""} ${row.defaultWorkItem?.name??""}`.toLowerCase().includes(needle))).map((row,index)=>({row,index})).sort((leftRow,rightRow)=>{
      const left=employeeSortValue(leftRow.row,sort),right=employeeSortValue(rightRow.row,sort);
      const result=typeof left==="number"&&typeof right==="number"?left-right:String(left).localeCompare(String(right),"zh-CN");
      return (descending?-result:result)||leftRow.index-rightRow.index;
    }).map(item=>item.row);
  },[data,descending,query,sort,status]);
  const changeSort=(key:EmployeeSortKey)=>setSortState(current=>current.key===key?{key,descending:!current.descending}:{key,descending:false});
  const toggle=async(employee:EmployeeRecord)=>{if(employee.active&&!window.confirm(t("确定停用 {0}？",{0:employee.name})))return;setError("");try{await timeApi("/api/v1/timekeeping/employees",{method:"PATCH",body:JSON.stringify({id:employee.id,active:!employee.active})});await load()}catch(saveError){setError(saveError instanceof Error?saveError.message:"员工状态更新失败")}};
  const attendanceAction=async(employee:EmployeeRecord,action:"sign_in"|"sign_out")=>{
    setPendingAction(`${employee.id}:${action}`);setError("");
    try{await timeApi("/api/v1/timekeeping/employees",{method:"PATCH",body:JSON.stringify({id:employee.id,action,requestId:crypto.randomUUID()})});await load()}
    catch(saveError){setError(saveError instanceof Error?saveError.message:`${action==="sign_in"?"Sign In":"Sign Out"} 失败`)}
    finally{setPendingAction(null)}
  };
  const exportScanAssets=async()=>{
    if(exporting)return;
    setExporting(true);setError("");
    try{
      const response=await fetchWithTimeout("/api/v1/timekeeping/employees/export",{cache:"no-store"},120_000);
      if(response.status===401){window.location.reload();return}
      if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};throw new Error(body.error??"员工扫描素材导出失败")}
      const disposition=response.headers.get("content-disposition")??"";
      const encodedName=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement("a");
      anchor.href=url;anchor.download=encodedName?decodeURIComponent(encodedName):"内库员工扫描素材.zip";anchor.click();
      window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(exportError){setError(exportError instanceof Error?exportError.message:"员工扫描素材导出失败")}
    finally{setExporting(false)}
  };
  if(!data&&!error)return <div className="time-page time-page-placeholder" aria-busy="true"/>;
  return <div className="time-page time-employees-page">
    {titleTarget&&createPortal(<div className="time-employee-titlebar"><div className="time-employee-title-filters"><label><span>{t("搜索")}</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t("员工 ID、姓名、组织或职能")} aria-label={t("搜索员工")}/></label><label><span>{t("状态")}</span><select value={status} onChange={event=>setStatus(event.target.value)} aria-label={t("员工状态")}><option value="active">{t("在职")}</option><option value="inactive">{t("已停用")}</option><option value="all">{t("全部")}</option></select></label><p>{t("共")} {rows.length} {t("名员工")}</p></div><div className="time-employee-title-actions"><button className="time-secondary" onClick={()=>setAttendanceExportOpen(true)} data-ui-size="">{t("考勤导出")}</button>{isAdmin&&<button className="time-secondary" disabled={exporting||!data?.employees.length} onClick={()=>void exportScanAssets()} data-ui-size="">{exporting?t("正在生成…"):t("导出扫描素材")}</button>}<button className="primary" onClick={()=>setAdding(true)} data-ui-size="">{t("新增员工")}</button></div></div>,titleTarget)}
    {error&&<div className="time-error">{t(error)}<button onClick={()=>void load()} data-ui-size="">{t("重试")}</button></div>}
      <section className="time-card"><div className="time-table-wrap"><table className="time-table time-data-table time-employee-table"><thead><tr><th className="time-employee-actions-col" data-ui-size="">{t("操作")}</th><SortHead label="员工 ID" field="badgeCode" current={sort} descending={descending} onClick={changeSort}/><SortHead label="姓名" field="name" current={sort} descending={descending} onClick={changeSort}/><SortHead label="组织" field="type" current={sort} descending={descending} onClick={changeSort}/><SortHead label="职能" field="defaultWorkItem" current={sort} descending={descending} onClick={changeSort}/><SortHead label="工况" field="attendanceState" current={sort} descending={descending} onClick={changeSort}/><SortHead label="最早 Sign In" field="todayFirstSignIn" current={sort} descending={descending} onClick={changeSort}/><SortHead label="最晚 Sign Out" field="todayLastSignOut" current={sort} descending={descending} onClick={changeSort}/><SortHead label="当日不在岗" field="todayOffDutyMs" current={sort} descending={descending} onClick={changeSort}/><SortHead label="当前任务" field="currentProject" current={sort} descending={descending} onClick={changeSort}/><SortHead label="今日在岗" field="todayMs" current={sort} descending={descending} onClick={changeSort}/></tr></thead><tbody>{rows.map(employee=>{
        const onDuty=employee.attendanceState==="working"||employee.attendanceState==="ready";
        const rowPending=pendingAction?.startsWith(`${employee.id}:`)??false;
        return <tr key={employee.id} className={!employee.active?"disabled-row":""}><td><div className="time-row-actions time-employee-row-actions"><button className="sign-in" disabled={rowPending||!employee.active||onDuty} onClick={()=>void attendanceAction(employee,"sign_in")} data-ui-size="">{t("Sign In")}</button><button className="sign-out" disabled={rowPending||!onDuty} onClick={()=>void attendanceAction(employee,"sign_out")} data-ui-size="">{t("Sign Out")}</button><button disabled={rowPending} onClick={()=>setEditing(employee)} data-ui-size="">{t("编辑")}</button><button className={employee.active?"danger":""} disabled={rowPending} onClick={()=>void toggle(employee)} data-ui-size="">{employee.active?t("停用"):t("启用")}</button></div></td><td>{openScan?<button type="button" className="time-employee-scan-link" onClick={()=>openScan(employee.badgeCode)} title={t("在任务分发中打开 {0}", {0: employee.name})}><code>{employee.badgeCode}</code></button>:<code>{employee.badgeCode}</code>}</td><td>{openRecords?<button type="button" className="time-employee-record-link" onClick={()=>openRecords(employee.badgeCode)}><b>{employee.name}</b></button>:<b>{employee.name}</b>}</td><td>{employee.type}</td><td className="time-truncate" title={employee.defaultWorkItem?.name}>{taskText(employee.defaultWorkItem?.name,employee.defaultWorkItem?.code)}</td><td><span className={`time-state ${employee.attendanceState}`}>{t(stateLabel(employee.attendanceState))}</span></td><td className="time-number">{employee.todayFirstSignIn?formatClock(employee.todayFirstSignIn):"—"}</td><td className="time-number">{employee.todayLastSignOut?formatClock(employee.todayLastSignOut):"—"}</td><td className="time-number">{durationText(formatDuration(employee.todayOffDutyMs))}</td><td className="time-truncate" title={employee.currentProject?.name}>{taskText(employee.currentProject?.name,employee.currentProject?.code)}</td><td className="time-number">{durationText(formatDuration(employee.todayMs))}</td></tr>
      })}</tbody></table></div>{rows.length===0&&<p className="time-empty">{t("当前筛选下暂无员工")}</p>}</section>
    {adding&&<AddEmployeesModal tasks={data?.standardTasks??[]} close={()=>setAdding(false)} saved={async()=>{setAdding(false);await load()}}/>}
    {editing&&<EditEmployeeModal employee={editing} tasks={data?.standardTasks??[]} close={()=>setEditing(null)} saved={async()=>{setEditing(null);await load()}}/>}
    {attendanceExportOpen&&<AttendanceExportModal close={()=>setAttendanceExportOpen(false)}/>}
  </div>;
}

function SortHead({label,field,current,descending,onClick}:{label:string;field:EmployeeSortKey;current:EmployeeSortKey;descending:boolean;onClick:(key:EmployeeSortKey)=>void}){
  useLanguage();const active=current===field;return <th aria-sort={active?(descending?"descending":"ascending"):"none"} data-ui-size=""><button className="time-sort" onClick={()=>onClick(field)} data-ui-size=""><span>{t(label)}</span><i aria-hidden="true">{active?(descending?"↓":"↑"):""}</i></button></th>}

function employeeSortValue(employee:EmployeeRecord,key:EmployeeSortKey):string|number{
  if(key==="attendanceState")return stateLabel(employee.attendanceState);
  if(key==="todayFirstSignIn"||key==="todayLastSignOut")return employee[key]?new Date(employee[key]).getTime():-1;
  if(key==="defaultWorkItem")return employee.defaultWorkItem?.name??"";
  if(key==="currentProject")return employee.currentProject?.name??"";
  return employee[key];
}

function AddEmployeesModal({tasks,close,saved}:{tasks:EmployeesResponse["standardTasks"];close:()=>void;saved:()=>Promise<void>}){
  useLanguage();
  const [names,setNames]=useState("");const [type,setType]=useState<"OZM"|"JJC">("OZM");const [defaultWorkItemId,setDefaultWorkItemId]=useState("");const [error,setError]=useState("");const [pending,setPending]=useState(false);
  const submit=async(event:FormEvent)=>{event.preventDefault();const items=names.split(/\r?\n/).map(name=>name.trim()).filter(Boolean).map(name=>({name,type,defaultWorkItemId:defaultWorkItemId||null}));if(!items.length){setError("请至少输入一名员工");return}setPending(true);setError("");try{await timeApi("/api/v1/timekeeping/employees",{method:"POST",body:JSON.stringify({items})});await saved()}catch(saveError){setError(saveError instanceof Error?saveError.message:"新增员工失败")}finally{setPending(false)}};
  return <div className="modal-backdrop"><form className="modal-card time-employee-modal" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">{t("员工数据")}</span><h3 data-ui-size="">{t("新增员工")}</h3></div><button type="button" onClick={close}>×</button></div><div className="time-edit-fields"><label><span>{t("组织类型")}</span><select value={type} onChange={event=>setType(event.target.value as "OZM"|"JJC")}><option>OZM</option><option>JJC</option></select></label><label><span>{t("职能")}</span><select value={defaultWorkItemId} onChange={event=>setDefaultWorkItemId(event.target.value)}><option value="">{t("未设置")}</option>{tasks.map(task=><option value={task.id} key={task.id}>{taskText(task.name,task.code)}</option>)}</select></label><label><span>{t("员工姓名（每行一人）")}</span><textarea value={names} onChange={event=>setNames(event.target.value)} rows={8} placeholder={t("张三\n李四\n王五")} required/></label>{error&&<div className="time-error">{t(error)}</div>}</div><div className="modal-actions"><button type="button" onClick={close} data-ui-size="">{t("取消")}</button><button className="primary" disabled={pending} data-ui-size="">{t("新增并分配 ID")}</button></div></form></div>;
}

function EditEmployeeModal({employee,tasks,close,saved}:{employee:EmployeeRecord;tasks:EmployeesResponse["standardTasks"];close:()=>void;saved:()=>Promise<void>}){
  useLanguage();
  const [name,setName]=useState(employee.name);const [type,setType]=useState(employee.type);const [defaultWorkItemId,setDefaultWorkItemId]=useState(String(employee.defaultWorkItem?.id??""));const [error,setError]=useState("");const [pending,setPending]=useState(false);
  const submit=async(event:FormEvent)=>{event.preventDefault();setPending(true);setError("");try{await timeApi("/api/v1/timekeeping/employees",{method:"PATCH",body:JSON.stringify({id:employee.id,name,type,defaultWorkItemId:defaultWorkItemId||null})});await saved()}catch(saveError){setError(saveError instanceof Error?saveError.message:"员工数据更新失败")}finally{setPending(false)}};
  return <div className="modal-backdrop"><form className="modal-card time-employee-modal" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">{employee.badgeCode}</span><h3 data-ui-size="">{t("编辑员工")}</h3></div><button type="button" onClick={close}>×</button></div><div className="time-edit-fields"><label><span>{t("姓名")}</span><input value={name} onChange={event=>setName(event.target.value)} required/></label><label><span>{t("组织类型")}</span><select value={type} onChange={event=>setType(event.target.value as "OZM"|"JJC")}><option>OZM</option><option>JJC</option></select></label><label><span>{t("职能")}</span><select value={defaultWorkItemId} onChange={event=>setDefaultWorkItemId(event.target.value)}><option value="">{t("未设置")}</option>{tasks.map(task=><option value={task.id} key={task.id}>{taskText(task.name,task.code)}</option>)}</select></label>{error&&<div className="time-error">{t(error)}</div>}</div><div className="modal-actions"><button type="button" onClick={close} data-ui-size="">{t("取消")}</button><button className="primary" disabled={pending} data-ui-size="">{t("保存")}</button></div></form></div>;
}

function AttendanceExportModal({close}:{close:()=>void}){
  useLanguage();
  const [period,setPeriod]=useState(currentDate().slice(0,7));const [scope,setScope]=useState<AttendanceExportScope>("month");const [error,setError]=useState("");const [pending,setPending]=useState(false);
  const submit=async(event:FormEvent)=>{event.preventDefault();setPending(true);setError("");try{
    const query=new URLSearchParams({period,scope});
    const data=await timeApi<AttendanceExportResponse>(`/api/v1/timekeeping/employees/attendance-export?${query.toString()}`);
    const maxPairs=Math.max(1,...data.records.map(record=>record.pairs.length));
    const attendanceHeaders=Array.from({length:maxPairs},(_,index)=>[`Sign In ${index+1}`,`Sign Out ${index+1}`]).flat();
    const headers=["姓名","组织","日期","星期",...attendanceHeaders];
    const rows=data.records.map(record=>{
      const attendance=record.pairs.flatMap(pair=>[formatAttendanceClock(pair.signIn,pair.signInModified),pair.signOut?formatAttendanceClock(pair.signOut,pair.signOutModified):""]);
      return [record.employeeName,record.type,record.workDate,attendanceWeekday(record.workDate),...attendance,...Array(maxPairs*2-attendance.length).fill("")];
    });
    const hasModified=data.records.some(record=>record.pairs.some(pair=>pair.signInModified||pair.signOutModified));
    const sheetRows=[headers,...rows,...(hasModified?[[],["* 表示该考勤时间曾被修改"]]:[])];
    await downloadWorkbook({fileName:`内库考勤-${data.range.startDate}-${data.range.endDate}.xlsx`,sheets:[{sheetName:"考勤明细",rows:sheetRows,widths:[16,10,13,10,...Array(maxPairs*2).fill(12)],autoFilter:`A1:${excelColumnName(headers.length)}${rows.length+1}`}]});
    close();
  }catch(exportError){setError(exportError instanceof Error?exportError.message:"考勤导出失败")}finally{setPending(false)}};
  return <div className="modal-backdrop"><form className="modal-card time-employee-modal" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">{t("员工数据")}</span><h3 data-ui-size="">{t("考勤导出")}</h3></div><button type="button" onClick={close}>×</button></div><div className="time-edit-fields"><label><span>{t("自然月")}</span><input type="month" value={period} onChange={event=>setPeriod(event.target.value)} required/></label><label><span>{t("导出范围")}</span><select value={scope} onChange={event=>setScope(event.target.value as AttendanceExportScope)}><option value="month">{t("整个自然月")}</option><option value="first-half">{t("上半月（1–15日）")}</option><option value="second-half">{t("下半月（16日–月末）")}</option></select></label>{error&&<div className="time-error">{t(error)}</div>}</div><div className="modal-actions"><button type="button" onClick={close} data-ui-size="">{t("取消")}</button><button className="primary" disabled={pending} data-ui-size="">{pending?t("正在导出…"):t("导出 Excel")}</button></div></form></div>;
}

function attendanceWeekday(date:string){return new Intl.DateTimeFormat("zh-CN",{weekday:"long"}).format(new Date(`${date}T12:00:00`))}
function formatAttendanceClock(timestamp:string,modified:boolean){return `${formatClockWithSeconds(timestamp)}${modified?"*":""}`}
function excelColumnName(column:number){let name="";for(let value=column;value>0;value=Math.floor((value-1)/26))name=String.fromCharCode(65+(value-1)%26)+name;return name}
