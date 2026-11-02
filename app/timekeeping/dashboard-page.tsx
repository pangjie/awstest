"use client";
import { t, useLanguage, taskText } from "@/app/ui-language";

import { createPortal } from "react-dom";
import { workDate } from "@/lib/timekeeping/time";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { downloadWorkbook } from "@/lib/excel-workbook";
import { parseWaveText, type ParsedWave } from "@/lib/timekeeping/waves";
import { timeApi } from "./api";
import { formatClockWithSeconds, formatDurationWithSeconds, stateLabel, waveHourlyPieces } from "./format";
import type { DashboardFilterKey, DashboardFilters, DashboardResponse, DashboardSortKey, DashboardSortState, WorkItem } from "./types";
import { LeadSummary } from "./wave-participants";
import { channelLabel, WaveChannelTag, WaveTypeTag, waveTypeInfo } from "./wave-display";

type WaveState="completed"|"interrupted"|"working"|"unstarted"|"paused";
type FilterOption={value:string;label:string;count:number};
const REVISION_POLL_MS=10_000;
const DASHBOARD_TASK_ORDER=["SINGLE-SCAN","SCAN","WAREHOUSE","PUTAWAY","LOCATION-MAINTENANCE","TODO","CLEAN"];
const STATE_OPTIONS:FilterOption[]=[
  {value:"unstarted",label:"未开始",count:0},{value:"working",label:"进行中",count:0},
  {value:"interrupted",label:"中断",count:0},{value:"paused",label:"暂停",count:0},{value:"completed",label:"已完成",count:0},
];
const WAVE_EXPORT_HEADERS=["渠道","类型","波次号","状态","SKU","订单","件数","负责人","协同人员","开始时间","完结时间","波次工时","时效","记录状态"];
const WAVE_EXPORT_WIDTHS=[12,9,22,10,8,8,8,15,28,24,24,14,12,10];

export default function DashboardPage({titleTarget,date,exportStartDate,exportEndDate,filters,setFilters,sortState,setSortState,exportKey,importOpen,closeImport,openScan}:{titleTarget:HTMLDivElement|null;date:string;exportStartDate:string;exportEndDate:string;filters:DashboardFilters;setFilters:Dispatch<SetStateAction<DashboardFilters>>;sortState:DashboardSortState;setSortState:Dispatch<SetStateAction<DashboardSortState>>;exportKey:number;importOpen:boolean;closeImport:()=>void;openScan?:((badge:string)=>void)}){
  useLanguage();
  const [todayExportError,setTodayExportError]=useState("");
  const [todayExportPending,setTodayExportPending]=useState(false);
  const [data,setData]=useState<DashboardResponse|null>(null);
  const [now,setNow]=useState(()=>Date.now());
  const [openFilter,setOpenFilter]=useState<DashboardFilterKey|null>(null);
  const [pendingWaveId,setPendingWaveId]=useState<number|null>(null);
  const [error,setError]=useState("");
  const revisionRef=useRef(0);
  const exportKeyRef=useRef(exportKey);
  const requestSequenceRef=useRef(0);
  const checkingRevisionRef=useRef(false);

  const load=useCallback(async(requestedDate:string)=>{
    const sequence=++requestSequenceRef.current;
    try{
      const next=await timeApi<DashboardResponse>(`/api/v1/timekeeping/dashboard?startDate=${requestedDate}&endDate=${requestedDate}`);
      if(sequence!==requestSequenceRef.current)return;
      revisionRef.current=next.revision;
      setData(next);
      setError("");
    }catch(loadError){
      if(sequence===requestSequenceRef.current)setError(loadError instanceof Error?loadError.message:"看板数据读取失败");
    }
  },[]);

  useEffect(()=>{
    const timer=window.setInterval(()=>setNow(Date.now()),1_000);
    return()=>window.clearInterval(timer);
  },[]);

  useEffect(()=>{
    const timer=window.setTimeout(()=>void load(date),0);
    return()=>window.clearTimeout(timer);
  },[date,load]);

  useEffect(()=>{
    let cancelled=false;
    const checkRevision=async()=>{
      if(cancelled||checkingRevisionRef.current||document.visibilityState!=="visible")return;
      checkingRevisionRef.current=true;
      try{
        const response=await fetchWithTimeout("/api/v1/timekeeping/revision",{
          cache:"no-store",
          headers:{"if-none-match":`"${revisionRef.current}"`},
        });
        if(cancelled||response.status===304)return;
        if(response.status===401){window.location.reload();return}
        if(!response.ok)return;
        const body=await response.json() as {revision?:number};
        if(typeof body.revision==="number"&&body.revision!==revisionRef.current){
          revisionRef.current=body.revision;
          await load(date);
        }
      }catch{
        // The next lightweight revision check retries automatically.
      }finally{
        checkingRevisionRef.current=false;
      }
    };
    const timer=window.setInterval(()=>void checkRevision(),REVISION_POLL_MS);
    const visibility=()=>void checkRevision();
    document.addEventListener("visibilitychange",visibility);
    return()=>{
      cancelled=true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange",visibility);
    };
  },[date,load]);

  const {projects,dailyTasks,taskTotals,waveKpis,completionKpis,employeeKpis}=useMemo(()=>dashboardView(data,now),[data,now]);
  const filterOptions=useMemo(()=>({
    channel:countOptions(projects.map(item=>channelLabel(item.channelName))),
    type:countOptions(projects.map(item=>waveTypeInfo(item.channelType).label)),
    state:STATE_OPTIONS.map(option=>({...option,count:projects.filter(item=>waveState(item)===option.value).length})),
    employee:participantOptions(projects),
  }),[projects]);
  const employeeFilterActive=filterOptions.employee.some(option=>filters.employee.includes(option.value));
  const visibleProjects=useMemo(()=>projects.filter(item=>(
    !filters.channel.includes(channelLabel(item.channelName))
    &&!filters.type.includes(waveTypeInfo(item.channelType).label)
    &&!filters.state.includes(waveState(item))
    &&(!employeeFilterActive||item.participants.some(person=>!filters.employee.includes(String(person.employeeId))))
  )),[employeeFilterActive,filters,projects]);
  const orderedProjects=useMemo(()=>sortWaves(visibleProjects,sortState),[sortState,visibleProjects]);
  const workRows=useMemo(()=>orderedProjects.map(waveExportRow),[orderedProjects]);
  const filtersActive=Object.values(filters).some(values=>values.length);
  const changeSort=(key:Exclude<DashboardSortKey,"default">)=>setSortState(current=>current.key===key?{key,descending:!current.descending}:{key,descending:true});
  const resetView=()=>{setFilters({channel:[],type:[],state:[],employee:[]});setSortState({key:"default",descending:false});setOpenFilter(null)};

  const exportDashboard=useCallback(async()=>{
    try{
      const exportData=await timeApi<DashboardResponse>(`/api/v1/timekeeping/dashboard?startDate=${exportStartDate}&endDate=${exportEndDate}`);
      const exportView=dashboardView(exportData,Date.now());
      const exportRows=exportView.projects.map(waveExportRow);
      const statisticRows:Array<Array<string|number>>=[
        ["统计项","数值","说明"],["日期范围",exportData.range.label,""],["波次数量",exportView.waveKpis.total,"按波次创建时间统计"],
        ["未开启波次",exportView.waveKpis.unstarted,""],["当前波次",exportView.waveKpis.current,""],["已完成波次",exportView.waveKpis.completed,""],
        ["完成波次单量",exportView.completionKpis.orders,""],["完成波次拣货件数",exportView.completionKpis.pieces,""],
        ["完成多件订单",exportView.completionKpis.multipleOrders,""],["完成混件订单",exportView.completionKpis.mixedOrders,""],
        ["员工总数",exportView.employeeKpis.total,"日期范围内曾 Sign In"],["拣货员工",exportView.employeeKpis.picking,"正在处理波次、单件扫描、混件扫描或问题单"],["其他作业员工",exportView.employeeKpis.warehouse,"正在处理其他工作项目"],["待命员工",exportView.employeeKpis.standby,"在岗且暂无任务"],
        ["在岗时长",formatDurationWithSeconds(exportView.taskTotals.onDutyMs),""],["工作时长",formatDurationWithSeconds(exportView.taskTotals.totalMs),""],["出库工时",formatDurationWithSeconds(exportView.taskTotals.outboundMs),"波次拣货＋单件扫描＋混件扫描"],["波次工时",formatDurationWithSeconds(exportView.taskTotals.waveMs),""],
        ...exportView.dailyTasks.map(task=>[task.name,formatDurationWithSeconds(task.totalMs),task.participants.map(person=>person.name).join("、")]),
      ];
      await downloadWorkbook({fileName:`现场看板-${exportData.range.startDate}-${exportData.range.endDate}.xlsx`,sheets:[
        {sheetName:"工作汇总",rows:[WAVE_EXPORT_HEADERS,...exportRows],widths:WAVE_EXPORT_WIDTHS,autoFilter:`A1:N${exportRows.length+1}`},
        {sheetName:"统计",rows:statisticRows,widths:[18,22,42]},
        {sheetName:"人员工况",rows:[["姓名","组织","工况","当前任务","首次 Sign In","最后 Sign Out"],...exportData.attendance.map(employee=>[employee.name,employee.type,stateLabel(employee.state),employee.currentProject?.name??"",employee.clockIn??"",employee.clockOut??""])],widths:[16,10,12,28,24,24],autoFilter:`A1:F${exportData.attendance.length+1}`},
      ]});
    }catch(exportError){setError(exportError instanceof Error?exportError.message:"现场看板导出失败")}
  },[exportEndDate,exportStartDate]);

  const exportFilteredWaves=useCallback(async()=>{
    if(!data)return;
    try{
      await downloadWorkbook({fileName:`工作汇总-${data.range.startDate}-${data.range.endDate}.xlsx`,sheets:[
        {sheetName:"工作汇总",rows:[WAVE_EXPORT_HEADERS,...workRows],widths:WAVE_EXPORT_WIDTHS,autoFilter:`A1:N${workRows.length+1}`},
      ]});
    }catch(exportError){setError(exportError instanceof Error?exportError.message:"工作汇总导出失败")}
  },[data,workRows]);

  useEffect(()=>{
    if(exportKeyRef.current===exportKey)return;
    exportKeyRef.current=exportKey;
    void exportDashboard();
  },[exportDashboard,exportKey]);

  const today=workDate(new Date(now));
  const canExportToday=Boolean(data?.todayExport?.ready&&data.todayExport.date===today&&!error&&!todayExportPending);
  const todayExportTarget=titleTarget?.querySelector("[data-today-wave-export]");
  const exportToday=async()=>{
    if(!canExportToday)return;
    setTodayExportPending(true);setTodayExportError("");
    try{
      const response=await fetchWithTimeout(`/api/v1/exports/waves?date=${today}`,{cache:"no-store",headers:{"X-Require-Completed-Today":"1"}});
      if(!response.ok){const body=await response.json();if(body.error?.code==="WAVES_NOT_COMPLETED")await load(date);throw new Error(body.error?.code==="WAVES_NOT_COMPLETED"?"当天波次尚未全部完结":body.error?.message??"导出失败")}
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");
      anchor.href=url;anchor.download=`波次数据-${today}.xlsx`;document.body.append(anchor);anchor.click();anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),30_000);
    }catch(exportError){setTodayExportError(exportError instanceof Error?exportError.message:"导出失败")}
    finally{setTodayExportPending(false)}
  };

  const mutate=async(item:WorkItem,action:"complete"|"interrupt"|"delete")=>{
    const prompt=action==="complete"?t("确定完结波次 {0}？所有进行中的该波次计时会结束。",{0:item.waveNo}):action==="interrupt"?t("确定中断波次 {0}？正在计时的参与人员将转为在岗待命。",{0:item.waveNo}):t("确定移除未开始的波次 {0}？",{0:item.waveNo});
    if(!window.confirm(prompt))return;
    setPendingWaveId(item.id);setError("");
    try{
      await timeApi(action==="delete"?`/api/v1/timekeeping/waves?id=${item.id}`:"/api/v1/timekeeping/waves",{
        method:action==="delete"?"DELETE":"PATCH",
        ...(action!=="delete"?{body:JSON.stringify({id:item.id,action})}:{}),
      });
      await load(date);
    }catch(saveError){setError(saveError instanceof Error?saveError.message:"波次操作失败")}
    finally{setPendingWaveId(null)}
  };

  if(!data&&!error)return <div className="time-page time-page-placeholder" aria-busy="true"/>;
  if(!data)return <div className="time-page"><div className="time-error">{t(error)}<button onClick={()=>void load(date)} data-ui-size="">{t("重试")}</button></div></div>;

  return <div className="time-page time-dashboard-page">
    {todayExportTarget&&createPortal(<button className="time-dashboard-export" type="button" disabled={!canExportToday} title={t("当天有波次且全部完结后可导出")} onClick={()=>void exportToday()} data-ui-size="">{t("导出今日波次")}</button>,todayExportTarget)}
    {(error||todayExportError)&&<div className="time-inline-warning">{t(error||todayExportError)}</div>}
    <div className="time-dashboard-main-grid">
      <aside className="time-dashboard-stat-column" aria-label={t("现场统计")}>
        <div className="time-dashboard-metrics">
          <WaveStatusMetric total={waveKpis.total} unstarted={waveKpis.unstarted} current={waveKpis.current} completed={waveKpis.completed}/>
          <CompletionMetric counts={completionKpis}/>
          <EmployeeStatusMetric total={employeeKpis.total} picking={employeeKpis.picking} warehouse={employeeKpis.warehouse} standby={employeeKpis.standby}/>
          <WorkHoursMetric onDutyMs={taskTotals.onDutyMs} productiveMs={taskTotals.totalMs} outboundMs={taskTotals.outboundMs}/>
        </div>
        <ProjectHoursSummary projects={projects} tasks={dailyTasks} waveMs={taskTotals.waveMs} openScan={openScan}/>
      </aside>

      <section className="time-card time-wave-board">
      <div className="time-card-title time-dashboard-wave-title"><div><h3 data-ui-size="">{t("工作汇总")}</h3><p>{t("当前波次及")} {data.range.label} {t("参与过的波次")}</p></div><div className="time-dashboard-wave-actions"><button type="button" className="time-dashboard-filter-export" disabled={!visibleProjects.length} onClick={()=>void exportFilteredWaves()} data-ui-size="">{t("导出筛选结果")}</button><div className="time-dashboard-filters">
        {(["channel","type","state","employee"] as const).map(key=><MultiSelectFilter key={key} label={{channel:"渠道",type:"类型",state:"状态",employee:"员工"}[key]} options={filterOptions[key]} excluded={filters[key]} open={openFilter===key} setOpen={open=>setOpenFilter(open?key:null)} setExcluded={excluded=>setFilters(current=>({...current,[key]:excluded}))}/>) }
        <button type="button" className="time-dashboard-filter-reset" disabled={!filtersActive&&sortState.key==="default"} onClick={resetView} data-ui-size="">{t("重置")}</button>
      </div></div></div>
      <div className="time-table-wrap"><table className="time-table time-data-table time-dashboard-wave-table"><colgroup><col className="time-wave-channel-col"/><col className="time-wave-type-col"/><col className="time-wave-number-col"/><col className="time-wave-state-col"/><col className="time-wave-count-col"/><col className="time-wave-count-col"/><col className="time-wave-count-col"/><col className="time-wave-lead-col"/><col className="time-wave-start-col"/><col className="time-wave-completed-col"/><col className="time-wave-duration-col"/><col className="time-wave-rate-col"/><col className="time-wave-action-col"/></colgroup><thead><tr><th data-ui-size="">{t("渠道")}</th><th data-ui-size="">{t("类型")}</th><th data-ui-size="">{t("波次号")}</th><th data-ui-size="">{t("状态")}</th><th>SKU</th><th data-ui-size="">{t("订单")}</th><th data-ui-size="">{t("件数")}</th><th data-ui-size="">{t("负责人")}</th><th data-ui-size="">{t("开始时间")}</th><th data-ui-size="">{t("完结时间")}</th><WaveSortHead label="波次工时" field="duration" current={sortState} onClick={changeSort}/><WaveSortHead label="时效" field="efficiency" current={sortState} onClick={changeSort}/><th data-ui-size="">{t("操作")}</th></tr></thead><tbody>{orderedProjects.map(item=><WaveRow item={item} key={item.id} pending={pendingWaveId===item.id} complete={()=>void mutate(item,"complete")} interrupt={()=>void mutate(item,"interrupt")} remove={()=>void mutate(item,"delete")} openScan={openScan}/>)}</tbody></table></div>
      {visibleProjects.length===0&&<p className="time-empty">{t("当前筛选下暂无波次")}</p>}
      </section>
    </div>

    {importOpen&&<WaveImportModal close={closeImport} saved={async()=>{closeImport();await load(date)}}/>}
  </div>;
}

function WorkHoursMetric({onDutyMs,productiveMs,outboundMs}:{onDutyMs:number;productiveMs:number;outboundMs:number}){
  useLanguage();return <article className="time-metric time-work-hours-metric"><span>{t("工时统计")}</span><div><label><small>{t("在岗时长")}</small><b><RollingClock value={formatDurationWithSeconds(onDutyMs)}/></b></label><label><small>{t("工作时长")}</small><b><RollingClock value={formatDurationWithSeconds(productiveMs)}/></b></label><label><small>{t("出库工时")}</small><b><RollingClock value={formatDurationWithSeconds(outboundMs)}/></b></label></div></article>}

function WaveStatusMetric({total,unstarted,current,completed}:{total:number;unstarted:number;current:number;completed:number}){
  useLanguage();return <article className="time-metric time-status-metric time-wave-status-metric"><span>{t("波次状态")}<small>{t("波次数量")} {total}</small></span><div><label><b>{unstarted}</b><small>{t("未开启")}</small></label><i>/</i><label><b>{current}</b><small>{t("当前")}</small></label><i>/</i><label><b>{completed}</b><small>{t("已完成")}</small></label></div></article>}

function CompletionMetric({counts}:{counts:ReturnType<typeof dashboardView>["completionKpis"]}){
  useLanguage();
  return <article className="time-metric time-status-metric time-completion-metric"><span>{t("完成情况")}</span><div>{([["orders","单量总数"],["pieces","拣货件数"],["multipleOrders","多件订单"],["mixedOrders","混件订单"]] as const).map(([key,label])=><label key={key}><small>{t(label)}</small><b><span>{counts[key]}</span><i>/</i><span>{counts.total[key]}</span></b></label>)}</div></article>;
}

function EmployeeStatusMetric({total,picking,warehouse,standby}:{total:number;picking:number;warehouse:number;standby:number}){
  useLanguage();return <article className="time-metric time-status-metric time-employee-status-metric"><span>{t("员工统计")}<small>{t("员工总数")} {total}</small></span><div><label><b>{picking}</b><small>{t("拣货")}</small></label><i>/</i><label><b>{warehouse}</b><small>{t("其他作业")}</small></label><i>/</i><label><b>{standby}</b><small>{t("待命")}</small></label></div></article>}

function ProjectHoursSummary({projects,tasks,waveMs,openScan}:{projects:WorkItem[];tasks:DashboardResponse["dailyTasks"];waveMs:number;openScan?:((badge:string)=>void)}){
  useLanguage();
  const people=new Map<number,DashboardResponse["dailyTasks"][number]["participants"][number]>();
  for(const project of projects)for(const person of project.participants){
    const current=people.get(person.employeeId);
    if(current){current.totalMs+=person.totalMs;current.active ||= person.active;}
    else people.set(person.employeeId,{employeeId:person.employeeId,badgeCode:person.badgeCode,name:person.name,totalMs:person.totalMs,active:person.active});
  }
  const participants=Array.from(people.values()).sort((left,right)=>left.name.localeCompare(right.name,"zh-CN")||left.employeeId-right.employeeId);
  const wave={id:0,code:"",name:"波次拣货",sortOrder:0,totalMs:waveMs,activeCount:participants.filter(person=>person.active).length,participants};
  const orderedTasks=[...DASHBOARD_TASK_ORDER.flatMap(code=>tasks.filter(task=>task.code===code)),...tasks.filter(task=>!DASHBOARD_TASK_ORDER.includes(task.code))];
  return <section className="time-project-hours"><h3>{t("项目工时")}</h3><div className="time-project-hours-head"><span>{t("项目")}</span><span>{t("累计用时")}</span><span>{t("当前人数")}</span></div>{[wave,...orderedTasks].map(task=><ProjectHoursRow task={task} openScan={openScan} key={task.id}/>)}</section>;
}

function ProjectHoursRow({task,openScan}:{task:DashboardResponse["dailyTasks"][number];openScan?:((badge:string)=>void)}){
  useLanguage();
  const panelId=useId();
  const label=task.code?taskText(task.name,task.code):t(task.name);
  return <details className={`time-project-hours-row${task.activeCount?" active":""}`} onPointerEnter={event=>{if(event.pointerType==="mouse")event.currentTarget.open=true}} onPointerLeave={event=>{if(event.pointerType==="mouse"&&!event.currentTarget.contains(document.activeElement))event.currentTarget.open=false}} onFocus={event=>{if(event.target.matches(":focus-visible"))event.currentTarget.open=true}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false}}>
    <summary aria-controls={panelId}><span>{label}</span><b><RollingClock value={formatDurationWithSeconds(task.totalMs)}/></b><small>{task.activeCount}</small></summary>
    <div id={panelId} className="time-daily-people-popover"><strong>{label} · {task.participants.length} {t("人")}</strong><div>{task.participants.map(person=>openScan?<button type="button" className={`time-daily-person${person.active?" active":""}`} key={person.employeeId} onClick={()=>openScan(person.badgeCode)} title={t("在任务分发中打开 {0}", {0: person.name})}><i/><b>{person.name}</b><small>{formatDurationWithSeconds(person.totalMs)}</small></button>:<span className={`time-daily-person${person.active?" active":""}`} key={person.employeeId}><i/><b>{person.name}</b><small>{formatDurationWithSeconds(person.totalMs)}</small></span>)}</div>{!task.participants.length&&<p className="time-stat-empty">{t("当前无人")}</p>}</div>
  </details>;
}

function RollingClock({value}:{value:string}){
  const [hours="0",minutes="00",seconds="00"]=value.split(":");
  const digits=(part:string,key:string)=><span className={`time-clock-${key}`}>{Array.from(part,(character,index)=><i className="digit" key={`${index}-${character}`}><span>{character}</span></i>)}</span>;
  return <span className="time-rolling-clock" aria-label={value}>{digits(hours,"hours")}<i className="separator">:</i>{digits(minutes,"minutes")}<i className="separator">:</i>{digits(seconds,"seconds")}</span>;
}

function MultiSelectFilter({label,options,excluded,open,setOpen,setExcluded}:{label:string;options:FilterOption[];excluded:string[];open:boolean;setOpen:(open:boolean)=>void;setExcluded:(excluded:string[])=>void}){
  useLanguage();
  const selected=options.filter(option=>!excluded.includes(option.value)).length;
  const summary=selected===options.length?t("全部"):selected===0?t("未选择"):t("已选 {0}",{0:selected});
  return <div className="time-dashboard-filter" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false)}}><span>{t(label)}</span><div><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{summary}<i>⌄</i></button>{open&&<div className="time-dashboard-filter-menu"><div><button type="button" onClick={()=>setExcluded([])} data-ui-size="">{t("全选")}</button><button type="button" onClick={()=>setExcluded(options.map(option=>option.value))} data-ui-size="">{t("清空")}</button></div>{options.map(option=><label key={option.value}><input type="checkbox" checked={!excluded.includes(option.value)} onChange={()=>setExcluded(excluded.includes(option.value)?excluded.filter(value=>value!==option.value):[...excluded,option.value])}/><span>{label==="员工"||label==="渠道"?option.label:t(option.label)}</span><small>{option.count}</small></label>)}</div>}</div></div>;
}

function WaveSortHead({label,field,current,onClick}:{label:string;field:Exclude<DashboardSortKey,"default">;current:DashboardSortState;onClick:(key:Exclude<DashboardSortKey,"default">)=>void}){
  useLanguage();const active=current.key===field;return <th aria-sort={active?(current.descending?"descending":"ascending"):"none"} data-ui-size=""><button type="button" className="time-sort time-wave-sort" aria-label={t("按{0}排序", {0: t(label)})} onClick={()=>onClick(field)} data-ui-size=""><span>{t(label)}</span><i aria-hidden="true">{active?(current.descending?"↓":"↑"):"↕"}</i></button></th>}

function WaveRow({item,pending,complete,interrupt,remove,openScan}:{item:WorkItem;pending:boolean;complete:()=>void;interrupt:()=>void;remove:()=>void;openScan?:((badge:string)=>void)}){
  useLanguage();
  const state=waveState(item);
  const lead=item.participants.find(person=>person.role==="lead");
  const helpers=item.participants.filter(person=>person.role==="helper");
  const removable=item.status==="active"&&item.employeeCount===0;
  const removeHint=removable?"移除未开始的波次":item.status==="active"?"已有人员参与，不能移除":"已完成波次不能移除";
  const interruptible=item.status==="active"&&item.activeCount>0&&!item.interruptedAt;
  const hourlyPieces=waveHourlyPieces(item);
  return <tr className={item.status==="completed"?"completed":item.interruptedAt?"interrupted":undefined}><td><WaveChannelTag value={item.channelName}/></td><td><WaveTypeTag value={item.channelType}/></td><td><code>{item.waveNo??item.code}</code></td><td><span className={`time-state ${waveStateClass(state)}`}>{t(waveStateLabel(state))}</span></td><td className="time-number">{item.skuCount}</td><td className="time-number">{item.orderCount}</td><td className="time-number">{item.pieceCount}</td><td><LeadSummary lead={lead} helpers={helpers} openScan={openScan}/></td><td className="time-number">{formatClockWithSeconds(item.startedAt)}</td><td className="time-number">{formatClockWithSeconds(item.completedAt)}</td><td className="time-number"><b>{formatDurationWithSeconds(item.totalMs)}</b></td><td className="time-number"><b>{hourlyPieces===null?"—":hourlyPieces.toLocaleString("en-US")}</b></td><td><div className="time-row-actions"><button disabled={pending||item.status==="completed"} onClick={complete} title={item.status==="completed"?t("该波次已经完结"):t("完结波次")} data-ui-size="">{t("完结")}</button><button className="interrupt" disabled={pending||!interruptible} onClick={interrupt} title={item.interruptedAt?t("该波次已中断"):item.activeCount?t("中断波次并将参与人员转为待命"):t("只有正在进行的波次可以中断")} data-ui-size="">{t("中断")}</button><button className="danger" disabled={pending||!removable} onClick={remove} title={removeHint} data-ui-size="">{t("移除")}</button></div></td></tr>;
}


function WaveImportModal({close,saved}:{close:()=>void;saved:()=>Promise<void>}){
  useLanguage();
  const [text,setText]=useState("");const [error,setError]=useState("");const [pending,setPending]=useState(false);const parsed=useMemo(()=>parseWaveText(text),[text]);
  const submit=async(event:FormEvent)=>{event.preventDefault();if(!parsed.length){setError("未识别到有效波次，请检查波次号。");return}setPending(true);setError("");try{await timeApi("/api/v1/timekeeping/waves",{method:"POST",body:JSON.stringify({items:parsed})});await saved()}catch(saveError){setError(saveError instanceof Error?saveError.message:"波次导入失败")}finally{setPending(false)}};
  return <div className="modal-backdrop"><form className="modal-card time-wave-import" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">{t("现场看板")}</span><h3 data-ui-size="">{t("导入当前波次")}</h3></div><button type="button" onClick={close}>×</button></div><div className="time-edit-fields"><label><span>{t("粘贴制表符或逗号分隔的波次数据")}</span><textarea value={text} onChange={event=>setText(event.target.value)} rows={9} placeholder={t("渠道\t波次号\t类型\tSKU数\t订单数\t件数\nAmazon\tW202608270001\t多件\t24\t80\t126")} required/></label><WavePreview rows={parsed}/>{error&&<div className="time-error">{t(error)}</div>}</div><div className="modal-actions"><button type="button" onClick={close} data-ui-size="">{t("取消")}</button><button className="primary" disabled={pending||!parsed.length} data-ui-size="">{t("导入")} {parsed.length} {t("个波次")}</button></div></form></div>;
}

function WavePreview({rows}:{rows:ParsedWave[]}){
  useLanguage();if(!rows.length)return <p className="time-empty">{t("尚未识别到可导入的波次")}</p>;return <div className="time-wave-preview">{rows.slice(0,8).map(row=><div key={row.waveNo}><b>{row.waveNo}</b><span>{row.channelName} · {row.channelType}</span><small>{row.skuCount} SKU / {row.orderCount} {t("单 /")} {row.pieceCount} {t("件")}</small></div>)}{rows.length>8&&<p>{t("还有")} {rows.length-8} {t("个波次")}</p>}</div>}

function dashboardView(data:DashboardResponse|null,now:number){
  const liveElapsed=data&&now>=new Date(data.range.start).getTime()&&now<new Date(data.range.end).getTime()?Math.max(0,now-new Date(data.generatedAt).getTime()):0;
  const projects=(data?.projectTotals??[]).map(item=>({...item,totalMs:item.totalMs+liveElapsed*item.activeCount,participants:item.participants.map(person=>({...person,totalMs:person.totalMs+(person.active?liveElapsed:0)}))}));
  const dailyTasks=(data?.dailyTasks??[]).map(item=>({...item,totalMs:item.totalMs+liveElapsed*item.activeCount,participants:item.participants.map(person=>({...person,totalMs:person.totalMs+(person.active?liveElapsed:0)}))}));
  const totals=data?.taskTotals;
  const attendance=data?.attendance??[];
  const onDutyMs=attendance.reduce((sum,employee)=>sum+employee.onDutyMs,0)+liveElapsed*attendance.filter(employee=>employee.clockOut===null).length;
  const outboundMs=(totals?.waveMs??0)+liveElapsed*(totals?.waveActiveCount??0)+dailyTasks.filter(task=>task.code==="SINGLE-SCAN"||task.code==="SCAN").reduce((sum,task)=>sum+task.totalMs,0);
  const taskTotals={onDutyMs,outboundMs,totalMs:(totals?.totalMs??0)+liveElapsed*(totals?.activeCount??0),waveMs:(totals?.waveMs??0)+liveElapsed*(totals?.waveActiveCount??0),activeCount:totals?.activeCount??0,waveActiveCount:totals?.waveActiveCount??0};
  const rangeStart=data?new Date(data.range.start).getTime():0;
  const rangeEnd=data?new Date(data.range.end).getTime():0;
  const datedProjects=projects.filter(item=>{const createdAt=new Date(item.createdAt).getTime();return createdAt>=rangeStart&&createdAt<rangeEnd});
  const waveKpis={total:datedProjects.length,current:datedProjects.filter(item=>waveState(item)==="working").length,unstarted:datedProjects.filter(item=>waveState(item)==="unstarted").length,completed:datedProjects.filter(item=>waveState(item)==="completed").length};
  const completionKpis=projects.reduce((totals,item)=>{
    const type=waveTypeInfo(item.channelType).label;
    totals.total.orders+=item.orderCount;
    totals.total.pieces+=item.pieceCount;
    if(type==="多件")totals.total.multipleOrders+=item.orderCount;
    if(type==="混件")totals.total.mixedOrders+=item.orderCount;
    if(item.status!=="completed")return totals;
    totals.orders+=item.orderCount;
    totals.pieces+=item.pieceCount;
    if(type==="多件")totals.multipleOrders+=item.orderCount;
    if(type==="混件")totals.mixedOrders+=item.orderCount;
    return totals;
  },{orders:0,pieces:0,multipleOrders:0,mixedOrders:0,total:{orders:0,pieces:0,multipleOrders:0,mixedOrders:0}});
  const pickingEmployees=new Set<number>();
  const warehouseEmployees=new Set<number>();
  for(const item of projects)for(const person of item.participants)if(person.active)pickingEmployees.add(person.employeeId);
  for(const task of dailyTasks){
    const employees=task.code==="SCAN"||task.code==="SINGLE-SCAN"||task.code==="TODO"?pickingEmployees:warehouseEmployees;
    for(const person of task.participants)if(person.active)employees.add(person.employeeId);
  }
  for(const employeeId of pickingEmployees)warehouseEmployees.delete(employeeId);
  const standby=data?.attendance.filter(employee=>employee.state==="ready").length??0;
  return {projects,dailyTasks,taskTotals,waveKpis,completionKpis,employeeKpis:{total:attendance.length,picking:pickingEmployees.size,warehouse:warehouseEmployees.size,standby}};
}

function countOptions(values:string[]):FilterOption[]{const counts=new Map<string,number>();for(const value of values)counts.set(value,(counts.get(value)??0)+1);return Array.from(counts,([value,count])=>({value,label:value,count}))}
function participantOptions(items:WorkItem[]):FilterOption[]{const options=new Map<number,FilterOption>();for(const item of items)for(const person of item.participants){const current=options.get(person.employeeId);if(current)current.count+=1;else options.set(person.employeeId,{value:String(person.employeeId),label:person.name,count:1})}return Array.from(options.values()).sort((left,right)=>left.label.localeCompare(right.label,"zh-CN"))}
function sortWaves(items:WorkItem[],state:DashboardSortState){
  const defaultOrder=(left:WorkItem,right:WorkItem)=>left.sortOrder-right.sortOrder||left.id-right.id;
  if(state.key==="default")return items.toSorted(defaultOrder);
  return items.toSorted((left,right)=>{
    const leftValue=state.key==="duration"?left.totalMs:waveHourlyPieces(left);
    const rightValue=state.key==="duration"?right.totalMs:waveHourlyPieces(right);
    if(leftValue===null)return rightValue===null?defaultOrder(left,right):1;
    if(rightValue===null)return -1;
    const compared=leftValue-rightValue;
    return (state.descending?-compared:compared)||defaultOrder(left,right);
  });
}
function waveExportRow(item:WorkItem):Array<string|number>{const lead=item.participants.find(person=>person.role==="lead");const helpers=item.participants.filter(person=>person.role==="helper");return [channelLabel(item.channelName),waveTypeInfo(item.channelType).label,item.waveNo??item.code,waveStateLabel(waveState(item)),item.skuCount,item.orderCount,item.pieceCount,lead?.name??"",helpers.map(person=>person.name).join("、"),item.startedAt??"",item.completedAt??"",formatDurationWithSeconds(item.totalMs),waveHourlyPieces(item)??"",item.status==="active"?"当前":"已完成"]}
function waveState(item:Pick<WorkItem,"status"|"interruptedAt"|"activeCount"|"startedAt">):WaveState{if(item.status==="completed")return "completed";if(item.interruptedAt)return "interrupted";if(item.activeCount>0)return "working";if(item.startedAt===null)return "unstarted";return "paused"}
function waveStateLabel(state:WaveState){return ({completed:"已完成",interrupted:"中断",working:"进行中",unstarted:"未开始",paused:"暂停"} as const)[state]}
function waveStateClass(state:WaveState){return state==="interrupted"?"interrupted":state==="working"?"working":state==="unstarted"?"ready":"off"}
