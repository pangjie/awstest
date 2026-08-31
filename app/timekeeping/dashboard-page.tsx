"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { downloadWorkbook } from "@/lib/excel-workbook";
import type { DashboardRangeId } from "@/lib/timekeeping/dashboard-range";
import { parseWaveText, type ParsedWave } from "@/lib/timekeeping/waves";
import { timeApi } from "./api";
import { formatClockWithSeconds, formatDurationWithSeconds, stateLabel } from "./format";
import type { DashboardResponse, WorkItem, WorkParticipant } from "./types";
import { channelLabel, WaveChannelTag, WaveTypeTag, waveTypeInfo } from "./wave-display";

type WaveState="completed"|"interrupted"|"working"|"unstarted"|"paused";
type FilterKey="channel"|"type"|"state"|"employee";
type FilterOption={value:string;label:string;count:number};
type WaveFilters=Record<FilterKey,string[]>;
const REVISION_POLL_MS=10_000;
const STATE_OPTIONS:FilterOption[]=[
  {value:"unstarted",label:"未开始",count:0},{value:"working",label:"进行中",count:0},
  {value:"interrupted",label:"中断",count:0},{value:"paused",label:"暂停",count:0},{value:"completed",label:"已完成",count:0},
];

export default function DashboardPage({date,range,exportKey,importOpen,closeImport}:{date:string;range:DashboardRangeId;exportKey:number;importOpen:boolean;closeImport:()=>void}){
  const [data,setData]=useState<DashboardResponse|null>(null);
  const [now,setNow]=useState(()=>Date.now());
  const [filters,setFilters]=useState<WaveFilters>({channel:[],type:[],state:[],employee:[]});
  const [openFilter,setOpenFilter]=useState<FilterKey|null>(null);
  const [pendingWaveId,setPendingWaveId]=useState<number|null>(null);
  const [error,setError]=useState("");
  const revisionRef=useRef(0);
  const exportKeyRef=useRef(exportKey);
  const requestSequenceRef=useRef(0);
  const checkingRevisionRef=useRef(false);

  const load=useCallback(async(requestedDate:string,requestedRange:DashboardRangeId)=>{
    const sequence=++requestSequenceRef.current;
    try{
      const next=await timeApi<DashboardResponse>(`/api/v1/timekeeping/dashboard?date=${requestedDate}&range=${requestedRange}`);
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
    const timer=window.setTimeout(()=>void load(date,range),0);
    return()=>window.clearTimeout(timer);
  },[date,range,load]);

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
          await load(date,range);
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
  },[date,range,load]);

  const liveElapsed=data&&now>=new Date(data.range.start).getTime()&&now<new Date(data.range.end).getTime()?Math.max(0,now-new Date(data.generatedAt).getTime()):0;
  const projects=useMemo(()=>(data?.projectTotals??[]).map(item=>({
    ...item,
    totalMs:item.totalMs+liveElapsed*item.activeCount,
    participants:item.participants.map(person=>({...person,totalMs:person.totalMs+(person.active?liveElapsed:0)})),
  })),[data,liveElapsed]);
  const dailyTasks=useMemo(()=>(data?.dailyTasks??[]).map(item=>({
    ...item,
    totalMs:item.totalMs+liveElapsed*item.activeCount,
    participants:item.participants.map(person=>({...person,totalMs:person.totalMs+(person.active?liveElapsed:0)})),
  })),[data,liveElapsed]);
  const taskTotals=useMemo(()=>{
    const totals=data?.taskTotals;
    const waveMs=(totals?.waveMs??0)+liveElapsed*(totals?.waveActiveCount??0);
    return {
      totalMs:(totals?.totalMs??0)+liveElapsed*(totals?.activeCount??0),waveMs,
      activeCount:totals?.activeCount??0,waveActiveCount:totals?.waveActiveCount??0,
    };
  },[data,liveElapsed]);
  const datedProjects=useMemo(()=>{
    if(!data)return [];
    const start=new Date(data.range.start).getTime(),end=new Date(data.range.end).getTime();
    return projects.filter(item=>{const createdAt=new Date(item.createdAt).getTime();return createdAt>=start&&createdAt<end});
  },[data,projects]);
  const waveKpis=useMemo(()=>({
    total:datedProjects.length,
    current:datedProjects.filter(item=>waveState(item)==="working").length,
    unstarted:datedProjects.filter(item=>waveState(item)==="unstarted").length,
    completed:datedProjects.filter(item=>waveState(item)==="completed").length,
  }),[datedProjects]);
  const employeeKpis=useMemo(()=>{
    const picking=data?.attendance.filter(employee=>employee.state==="working").length??0;
    const standby=data?.attendance.filter(employee=>employee.state==="ready").length??0;
    return {total:picking+standby,picking,standby};
  },[data]);
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

  const exportDashboard=useCallback(async()=>{
    if(!data)return;
    try{
      const workRows=visibleProjects.map(item=>{
        const lead=item.participants.find(person=>person.role==="lead");
        const helpers=item.participants.filter(person=>person.role==="helper");
        return [channelLabel(item.channelName),waveTypeInfo(item.channelType).label,item.waveNo??item.code,waveStateLabel(waveState(item)),item.skuCount,item.orderCount,item.pieceCount,lead?.name??"",helpers.map(person=>person.name).join("、"),item.startedAt??"",formatDurationWithSeconds(item.totalMs),item.status==="active"?"当前":"已完成"];
      });
      const statisticRows:Array<Array<string|number>>=[
        ["统计项","数值","说明"],["日期范围",data.range.label,""],["波次数量",waveKpis.total,"按波次创建时间统计"],
        ["未开启波次",waveKpis.unstarted,""],["当前波次",waveKpis.current,""],["已完成波次",waveKpis.completed,""],
        ["员工总数",employeeKpis.total,"当前在岗"],["拣货员工",employeeKpis.picking,"正在处理任务"],["待命员工",employeeKpis.standby,"在岗且暂无任务"],
        ["工作总时长",formatDurationWithSeconds(taskTotals.totalMs),`${taskTotals.activeCount} 人当前计时`],["波次工时",formatDurationWithSeconds(taskTotals.waveMs),`${taskTotals.waveActiveCount} 人处理波次`],
        ...dailyTasks.map(task=>[task.name,formatDurationWithSeconds(task.totalMs),task.participants.map(person=>person.name).join("、")]),
      ];
      await downloadWorkbook({fileName:`现场看板-${data.date}-${data.range.id}.xlsx`,sheets:[
        {sheetName:"工作汇总",rows:[["渠道","类型","波次号","状态","SKU","订单","件数","负责人","协同","开始时间","波次工时","记录状态"],...workRows],widths:[12,9,22,10,8,8,8,15,28,24,14,10],autoFilter:`A1:L${workRows.length+1}`},
        {sheetName:"统计",rows:statisticRows,widths:[18,22,42]},
        {sheetName:"人员工况",rows:[["姓名","组织","工况","当前任务","首次 Sign In","最后 Sign Out"],...data.attendance.map(employee=>[employee.name,employee.type,stateLabel(employee.state),employee.currentProject?.name??"",employee.clockIn??"",employee.clockOut??""])],widths:[16,10,12,28,24,24],autoFilter:`A1:F${data.attendance.length+1}`},
      ]});
    }catch(exportError){setError(exportError instanceof Error?exportError.message:"现场看板导出失败")}
  },[dailyTasks,data,employeeKpis,taskTotals,visibleProjects,waveKpis]);

  useEffect(()=>{
    if(exportKeyRef.current===exportKey||!data)return;
    exportKeyRef.current=exportKey;
    void exportDashboard();
  },[data,exportDashboard,exportKey]);

  const mutate=async(item:WorkItem,action:"complete"|"interrupt"|"delete")=>{
    const prompt=action==="complete"?`确定完结波次 ${item.waveNo}？所有进行中的该波次计时会结束。`:action==="interrupt"?`确定中断波次 ${item.waveNo}？正在计时的参与人员将转为在岗待命。`:`确定移除未开始的波次 ${item.waveNo}？`;
    if(!window.confirm(prompt))return;
    setPendingWaveId(item.id);setError("");
    try{
      await timeApi(action==="delete"?`/api/v1/timekeeping/waves?id=${item.id}`:"/api/v1/timekeeping/waves",{
        method:action==="delete"?"DELETE":"PATCH",
        ...(action!=="delete"?{body:JSON.stringify({id:item.id,action})}:{}),
      });
      await load(date,range);
    }catch(saveError){setError(saveError instanceof Error?saveError.message:"波次操作失败")}
    finally{setPendingWaveId(null)}
  };

  if(!data&&!error)return <div className="time-page time-page-placeholder" aria-busy="true"/>;
  if(!data)return <div className="time-page"><div className="time-error">{error}<button onClick={()=>void load(date,range)}>重试</button></div></div>;

  return <div className="time-page time-dashboard-page">
    {error&&<div className="time-inline-warning">{error}</div>}
    <div className="time-dashboard-main-grid">
      <aside className="time-dashboard-stat-column" aria-label="现场统计">
        <div className="time-dashboard-metrics">
          <WaveStatusMetric total={waveKpis.total} unstarted={waveKpis.unstarted} current={waveKpis.current} completed={waveKpis.completed}/>
          <EmployeeStatusMetric total={employeeKpis.total} picking={employeeKpis.picking} standby={employeeKpis.standby}/>
          <Metric label="工作总时长" value={formatDurationWithSeconds(taskTotals.totalMs)} note={`${taskTotals.activeCount} 人当前计时`} timer/>
          <Metric label="波次工时" value={formatDurationWithSeconds(taskTotals.waveMs)} note={`${taskTotals.waveActiveCount} 人处理波次`} timer/>
        </div>
        <DailyTaskSummary tasks={dailyTasks}/>
        <EmployeeStatusList attendance={data.attendance}/>
      </aside>

      <section className="time-card time-wave-board">
      <div className="time-card-title time-dashboard-wave-title"><div><h3>工作汇总</h3><p>当前波次及所选日期参与过的波次</p></div><div className="time-dashboard-filters">
        {(["channel","type","state","employee"] as const).map(key=><MultiSelectFilter key={key} label={{channel:"渠道",type:"类型",state:"状态",employee:"员工"}[key]} options={filterOptions[key]} excluded={filters[key]} open={openFilter===key} setOpen={open=>setOpenFilter(open?key:null)} setExcluded={excluded=>setFilters(current=>({...current,[key]:excluded}))}/>) }
      </div></div>
      <div className="time-table-wrap"><table className="time-table time-data-table time-dashboard-wave-table"><colgroup><col className="time-wave-channel-col"/><col className="time-wave-type-col"/><col className="time-wave-number-col"/><col className="time-wave-state-col"/><col className="time-wave-count-col"/><col className="time-wave-count-col"/><col className="time-wave-count-col"/><col className="time-wave-lead-col"/><col className="time-wave-helper-col"/><col className="time-wave-start-col"/><col className="time-wave-duration-col"/><col className="time-wave-action-col"/></colgroup><thead><tr><th>渠道</th><th>类型</th><th>波次号</th><th>状态</th><th>SKU</th><th>订单</th><th>件数</th><th>负责人</th><th>协同</th><th>开始时间</th><th>波次工时</th><th>操作</th></tr></thead><tbody>{visibleProjects.map(item=><WaveRow item={item} key={item.id} pending={pendingWaveId===item.id} complete={()=>void mutate(item,"complete")} interrupt={()=>void mutate(item,"interrupt")} remove={()=>void mutate(item,"delete")}/>)}</tbody></table></div>
      {visibleProjects.length===0&&<p className="time-empty">当前筛选下暂无波次</p>}
      </section>
    </div>

    {importOpen&&<WaveImportModal close={closeImport} saved={async()=>{closeImport();await load(date,range)}}/>}
  </div>;
}

function Metric({label,value,note,timer=false}:{label:string;value:string|number;note:string;timer?:boolean}){return <article className="time-metric"><span>{label}</span><b>{timer?<RollingClock value={String(value)}/>:value}</b><small>{note}</small></article>}

function WaveStatusMetric({total,unstarted,current,completed}:{total:number;unstarted:number;current:number;completed:number}){return <article className="time-metric time-status-metric time-wave-status-metric"><span>波次状态<small>波次数量 {total}</small></span><div><label><b>{unstarted}</b><small>未开启</small></label><i>/</i><label><b>{current}</b><small>当前</small></label><i>/</i><label><b>{completed}</b><small>已完成</small></label></div></article>}

function EmployeeStatusMetric({total,picking,standby}:{total:number;picking:number;standby:number}){return <article className="time-metric time-status-metric time-employee-status-metric"><span>员工统计</span><div><label><b>{total}</b><small>总数</small></label><i>/</i><label><b>{picking}</b><small>拣货</small></label><i>/</i><label><b>{standby}</b><small>待命</small></label></div></article>}

function DailyTaskSummary({tasks}:{tasks:DashboardResponse["dailyTasks"]}){
  return <section className="time-dashboard-stat-group"><div className="time-daily-task-grid">{tasks.map(task=><article className={`time-metric time-daily-stat${task.activeCount?" active":""}`} key={task.id}><span>{task.name}</span><b><RollingClock value={formatDurationWithSeconds(task.totalMs)}/></b><small>{task.activeCount?`${task.activeCount} 人计时`:"当前无人"}</small><div className="time-daily-people">{task.participants.length?task.participants.map(person=><span className={person.active?"active":""} key={person.employeeId}><i/><b>{person.name}</b><small>{formatDurationWithSeconds(person.totalMs)}</small></span>):<em>该时间段暂无参与人员</em>}</div></article>)}</div></section>;
}

function RollingClock({value}:{value:string}){
  return <span className="time-rolling-clock" aria-label={value}>{Array.from(value,(character,index)=>character===":"?<i className="separator" key={index}>:</i>:<i className="digit" key={`${index}-${character}`}><span>{character}</span></i>)}</span>;
}

function EmployeeStatusList({attendance}:{attendance:DashboardResponse["attendance"]}){
  return <section className="time-dashboard-stat-group time-dashboard-employee-stats"><div>{attendance.map(employee=><article className="time-dashboard-employee" key={employee.employeeId}><b>{employee.name}</b><span className={`time-state ${employee.state}`}>{stateLabel(employee.state)}</span><p title={employee.currentProject?.name}>{employee.currentProject?.name??(employee.state==="off"?"已完成工时":"暂无工作项目")}</p></article>)}{!attendance.length&&<p className="time-stat-empty">该时间段暂无人员 Sign In</p>}</div></section>;
}

function MultiSelectFilter({label,options,excluded,open,setOpen,setExcluded}:{label:string;options:FilterOption[];excluded:string[];open:boolean;setOpen:(open:boolean)=>void;setExcluded:(excluded:string[])=>void}){
  const selected=options.filter(option=>!excluded.includes(option.value)).length;
  const summary=selected===options.length?"全部":selected===0?"未选择":`已选 ${selected}`;
  return <div className="time-dashboard-filter" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false)}}><span>{label}</span><div><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{summary}<i>⌄</i></button>{open&&<div className="time-dashboard-filter-menu"><div><button type="button" onClick={()=>setExcluded([])}>全选</button><button type="button" onClick={()=>setExcluded(options.map(option=>option.value))}>清空</button></div>{options.map(option=><label key={option.value}><input type="checkbox" checked={!excluded.includes(option.value)} onChange={()=>setExcluded(excluded.includes(option.value)?excluded.filter(value=>value!==option.value):[...excluded,option.value])}/><span>{option.label}</span><small>{option.count}</small></label>)}</div>}</div></div>;
}

function WaveRow({item,pending,complete,interrupt,remove}:{item:WorkItem;pending:boolean;complete:()=>void;interrupt:()=>void;remove:()=>void}){
  const state=waveState(item);
  const lead=item.participants.find(person=>person.role==="lead");
  const helpers=item.participants.filter(person=>person.role==="helper");
  const removable=item.status==="active"&&item.employeeCount===0;
  const removeHint=removable?"移除未开始的波次":item.status==="active"?"已有人员参与，不能移除":"已完成波次不能移除";
  const interruptible=item.status==="active"&&item.activeCount>0&&!item.interruptedAt;
  return <tr className={item.status==="completed"?"completed":item.interruptedAt?"interrupted":undefined}><td><WaveChannelTag value={item.channelName}/></td><td><WaveTypeTag value={item.channelType}/></td><td><code>{item.waveNo??item.code}</code></td><td><span className={`time-state ${waveStateClass(state)}`}>{waveStateLabel(state)}</span></td><td className="time-number">{item.skuCount}</td><td className="time-number">{item.orderCount}</td><td className="time-number">{item.pieceCount}</td><td>{lead?<PersonTag person={lead}/>:<em className="time-person-empty">—</em>}</td><td><HelperSummary helpers={helpers}/></td><td className="time-number">{formatClockWithSeconds(item.startedAt)}</td><td className="time-number"><b>{formatDurationWithSeconds(item.totalMs)}</b></td><td><div className="time-row-actions"><button disabled={pending||item.status==="completed"} onClick={complete} title={item.status==="completed"?"该波次已经完结":"完结波次"}>完结</button><button className="interrupt" disabled={pending||!interruptible} onClick={interrupt} title={item.interruptedAt?"该波次已中断":item.activeCount?"中断波次并将参与人员转为待命":"只有正在进行的波次可以中断"}>中断</button><button className="danger" disabled={pending||!removable} onClick={remove} title={removeHint}>移除</button></div></td></tr>;
}

function HelperSummary({helpers}:{helpers:WorkParticipant[]}){
  const triggerRef=useRef<HTMLButtonElement>(null);
  const tooltipId=useId();
  const [position,setPosition]=useState<{left:number;top:number;above:boolean}|null>(null);
  const show=()=>{
    const trigger=triggerRef.current;if(!trigger||!helpers.length)return;
    const bounds=trigger.getBoundingClientRect();
    const width=Math.min(370,window.innerWidth-24);
    const above=window.innerHeight-bounds.bottom<170&&bounds.top>170;
    setPosition({left:Math.max(12,Math.min(window.innerWidth-width-12,bounds.left+bounds.width/2-width/2)),top:above?bounds.top-8:bounds.bottom+8,above});
  };
  const hide=()=>setPosition(null);
  return <div className="time-dashboard-helper-summary"><button ref={triggerRef} type="button" aria-describedby={position?tooltipId:undefined} aria-label={helpers.length?`协同 ${helpers.length} 人：${helpers.map(person=>person.name).join("、")}`:"无协同人员"} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}><b>{helpers.length}</b><span>人</span></button>{position&&createPortal(<div id={tooltipId} role="tooltip" className={`time-dashboard-helper-popover${position.above?" above":""}`} style={{left:position.left,top:position.top}}><strong>协同人员 · {helpers.length}</strong><div>{helpers.map(person=><PersonTag person={person} key={person.employeeId}/>)}</div></div>,document.body)}</div>;
}

function PersonTag({person}:{person:WorkParticipant}){return <span className={`time-dashboard-person${person.active?" active":""}`} title={`${person.name} · ${formatDurationWithSeconds(person.totalMs)}`}><i/><b>{person.name}</b><small>{formatDurationWithSeconds(person.totalMs)}</small></span>}

function WaveImportModal({close,saved}:{close:()=>void;saved:()=>Promise<void>}){
  const [text,setText]=useState("");const [error,setError]=useState("");const [pending,setPending]=useState(false);const parsed=useMemo(()=>parseWaveText(text),[text]);
  const submit=async(event:FormEvent)=>{event.preventDefault();if(!parsed.length){setError("未识别到有效波次，请检查波次号。");return}setPending(true);setError("");try{await timeApi("/api/v1/timekeeping/waves",{method:"POST",body:JSON.stringify({items:parsed})});await saved()}catch(saveError){setError(saveError instanceof Error?saveError.message:"波次导入失败")}finally{setPending(false)}};
  return <div className="modal-backdrop"><form className="modal-card time-wave-import" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">现场看板</span><h3>导入当前波次</h3></div><button type="button" onClick={close}>×</button></div><div className="time-edit-fields"><label><span>粘贴制表符或逗号分隔的波次数据</span><textarea value={text} onChange={event=>setText(event.target.value)} rows={9} placeholder={"渠道\t波次号\t类型\tSKU数\t订单数\t件数\nAmazon\tW202608270001\t多件\t24\t80\t126"} required/></label><WavePreview rows={parsed}/>{error&&<div className="time-error">{error}</div>}</div><div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={pending||!parsed.length}>导入 {parsed.length} 个波次</button></div></form></div>;
}

function WavePreview({rows}:{rows:ParsedWave[]}){if(!rows.length)return <p className="time-empty">尚未识别到可导入的波次</p>;return <div className="time-wave-preview">{rows.slice(0,8).map(row=><div key={row.waveNo}><b>{row.waveNo}</b><span>{row.channelName} · {row.channelType}</span><small>{row.skuCount} SKU / {row.orderCount} 单 / {row.pieceCount} 件</small></div>)}{rows.length>8&&<p>还有 {rows.length-8} 个波次</p>}</div>}

function countOptions(values:string[]):FilterOption[]{const counts=new Map<string,number>();for(const value of values)counts.set(value,(counts.get(value)??0)+1);return Array.from(counts,([value,count])=>({value,label:value,count}))}
function participantOptions(items:WorkItem[]):FilterOption[]{const options=new Map<number,FilterOption>();for(const item of items)for(const person of item.participants){const current=options.get(person.employeeId);if(current)current.count+=1;else options.set(person.employeeId,{value:String(person.employeeId),label:person.name,count:1})}return Array.from(options.values()).sort((left,right)=>left.label.localeCompare(right.label,"zh-CN"))}
function waveState(item:Pick<WorkItem,"status"|"interruptedAt"|"activeCount"|"startedAt">):WaveState{if(item.status==="completed")return "completed";if(item.interruptedAt)return "interrupted";if(item.activeCount>0)return "working";if(item.startedAt===null)return "unstarted";return "paused"}
function waveStateLabel(state:WaveState){return ({completed:"已完成",interrupted:"中断",working:"进行中",unstarted:"未开始",paused:"暂停"} as const)[state]}
function waveStateClass(state:WaveState){return state==="interrupted"?"interrupted":state==="working"?"working":state==="unstarted"?"ready":"off"}
