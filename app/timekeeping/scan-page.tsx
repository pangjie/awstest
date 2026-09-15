"use client";

import { type Dispatch, type SetStateAction, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { workDate } from "@/lib/timekeeping/time";
import { isValidEmployeeId } from "@/lib/timekeeping/employee-id";
import { timeApi } from "./api";
import { formatClock, formatClockWithSeconds, formatDurationWithSeconds, stateLabel } from "./format";
import type { EmployeeSnapshot, ScanWaveSortKey, ScanWaveSortState, ScanResponse, WorkItem, WorkItemsResponse } from "./types";
import { channelLabel, waveTypeInfo, WaveChannelTag, WaveTypeTag } from "./wave-display";

type ScanSelection={key:string;code:string;label:string;projectId?:number;extra?:Record<string,unknown>;confirmMessage?:string};

export default function ScanPage({titleTarget,initialBadge,sortState,setSortState}:{titleTarget:HTMLDivElement|null;initialBadge:string;sortState:ScanWaveSortState;setSortState:Dispatch<SetStateAction<ScanWaveSortState>>}){
  const [code,setCode]=useState(initialBadge);
  const [snapshot,setSnapshot]=useState<EmployeeSnapshot|null>(null);
  const [workItems,setWorkItems]=useState<WorkItemsResponse|null>(null);
  const [selection,setSelection]=useState<ScanSelection|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const inputRef=useRef<HTMLInputElement>(null);
  const [elapsed,setElapsed]=useState(0);
  const [snapshotElapsed,setSnapshotElapsed]=useState(0);
  const baselineRef=useRef(0);
  const snapshotBaselineRef=useRef(0);
  const employeeRef=useRef<number|null>(null);
  const revisionRef=useRef(0);
  const dateRef=useRef("");
  const requestRef=useRef(0);
  const busyRef=useRef(false);
  const selectionContextRef=useRef("");

  const loadWorkItems=useCallback(async()=>{
    const sequence=++requestRef.current;
    const employeeId=employeeRef.current;
    const next=await timeApi<WorkItemsResponse&{revision:number;snapshot:EmployeeSnapshot|null}>(`/api/v1/timekeeping/scan${employeeId?`?employeeId=${employeeId}`:""}`);
    if(sequence!==requestRef.current||employeeId!==employeeRef.current)return;
    baselineRef.current=performance.now();setElapsed(0);
    setWorkItems(next);revisionRef.current=next.revision;dateRef.current=workDate();
    if(employeeId){setSnapshot(next.snapshot);snapshotBaselineRef.current=performance.now();setSnapshotElapsed(0)}
  },[]);
  useEffect(()=>{
    let cancelled=false,checking=false;
    const requests=requestRef;
    const refresh=async(force=false)=>{
      if(cancelled||checking||busyRef.current||document.visibilityState!=="visible")return;
      checking=true;
      try{
        if(force||dateRef.current!==workDate())await loadWorkItems();
        else{
          const response=await fetchWithTimeout("/api/v1/timekeeping/revision",{cache:"no-store",headers:{"if-none-match":`"${revisionRef.current}"`}});
          if(response.status===401){window.location.reload();return}
          if(response.ok&&!cancelled&&!busyRef.current)await loadWorkItems();
        }
      }catch{/* Retry on the next poll without interrupting a pending selection. */}
      finally{checking=false}
    };
    void loadWorkItems().catch(error=>{if(!cancelled)setError(error instanceof Error?error.message:"任务数据读取失败")});
    const poll=window.setInterval(()=>void refresh(),10_000);
    const clock=window.setInterval(()=>{
      if(document.visibilityState!=="visible")return;
      setElapsed(Math.max(0,performance.now()-baselineRef.current));
      setSnapshotElapsed(Math.max(0,performance.now()-snapshotBaselineRef.current));
    },1_000);
    const visible=()=>void refresh(true);
    document.addEventListener("visibilitychange",visible);
    return()=>{cancelled=true;requests.current++;window.clearInterval(poll);window.clearInterval(clock);document.removeEventListener("visibilitychange",visible)};
  },[loadWorkItems]);
  useEffect(()=>{inputRef.current?.focus()},[snapshot?.employee.id,titleTarget]);

  const scan=useCallback(async(scannedCode:string,extra:Record<string,unknown>={})=>{
    const normalized=scannedCode.trim();
    if(!normalized||busyRef.current)return;
    busyRef.current=true;requestRef.current++;
    setPending(true);setError("");
    try{
      const response=await timeApi<ScanResponse>("/api/v1/timekeeping/scan",{method:"POST",body:JSON.stringify({code:normalized,employeeId:snapshot?.employee.id,requestId:crypto.randomUUID(),terminalId:"browser-main",...extra})});
      if(response.snapshot){setSnapshot(response.snapshot);employeeRef.current=response.snapshot.employee.id;snapshotBaselineRef.current=performance.now();setSnapshotElapsed(0)}
      await loadWorkItems();
      setSelection(null);
    }catch(scanError){setError(scanError instanceof Error?scanError.message:"扫描操作失败")}
    finally{busyRef.current=false;setPending(false);setCode("");requestAnimationFrame(()=>inputRef.current?.focus())}
  },[loadWorkItems,snapshot]);

  const currentLeadWave=snapshot?.shift&&snapshot.currentProject?.workType==="wave"&&snapshot.currentProject.assignmentRole==="lead"&&snapshot.currentProject.status==="active"?snapshot.currentProject:null;
  const employeeOperations=snapshot?workItems?.todayOperations.filter(item=>item.employeeId===snapshot.employee.id)??[]:[];
  const selectItem=useCallback((item:Pick<WorkItem,"id"|"code"|"name"|"waveNo">)=>{
    if(!snapshot)return;
    selectionContextRef.current=selectionContext(snapshot);
    setError("");
    const switchingTask=Boolean(snapshot.currentProject&&snapshot.currentProject.id!==item.id);
    const switchingLead=Boolean(currentLeadWave&&currentLeadWave.id!==item.id);
    setSelection({
      key:`item:${item.id}`,projectId:item.id,label:`${item.waveNo??item.name}`,
      code:snapshot.shift?item.code:"ACT-CLOCKIN",
      extra:{...(!snapshot.shift?{projectCode:item.code}:{}),...(switchingLead?{completeProjectId:currentLeadWave?.id}:{})},
      confirmMessage:switchingLead
        ?`完结波次 ${currentLeadWave?.waveNo??currentLeadWave?.code} 并切换到 ${item.waveNo??item.name}？`
        :switchingTask?`确定将任务从 ${snapshot.currentProject?.waveNo??snapshot.currentProject?.name} 切换到 ${item.waveNo??item.name}？`:undefined,
    });
  },[currentLeadWave,snapshot]);
  const selectAction=useCallback((action:"clock-in"|"clock-out"|"complete")=>{
    if(!snapshot)return;
    selectionContextRef.current=selectionContext(snapshot);
    setError("");
    if(action==="clock-in"){setSelection({key:action,code:"ACT-CLOCKIN",label:"上班 / Sign In"});return}
    if(action==="clock-out"){setSelection({key:action,code:"ACT-OUT",label:"下班 / Sign Out"});return}
    if(!currentLeadWave){setError("当前没有可完结的负责人波次");return}
    setSelection({key:action,code:"ACT-WAVE-COMPLETE",label:`完结 ${currentLeadWave.waveNo??currentLeadWave.code}`,extra:{completeProjectId:currentLeadWave.id},confirmMessage:`确定完结波次 ${currentLeadWave.waveNo??currentLeadWave.code}？`});
  },[currentLeadWave,snapshot]);
  const selectScannedCode=useCallback((scannedCode:string)=>{
    const normalized=scannedCode.trim().toUpperCase();
    if(isValidEmployeeId(normalized)){void scan(normalized);return}
    if(normalized==="ACT-CLOCKIN"){selectAction("clock-in");setCode("");return}
    if(normalized==="ACT-OUT"||normalized==="OUT"||normalized==="下班"){selectAction("clock-out");setCode("");return}
    if(normalized==="ACT-WAVE-COMPLETE"){selectAction("complete");setCode("");return}
    const item=[...(workItems?.standardTasks??[]),...(workItems?.currentWaves??[])].find(candidate=>[candidate.barcode,candidate.code,candidate.waveNo].some(value=>value?.toUpperCase()===normalized));
    if(item){selectItem(item);setCode("");return}
    setError(`无法识别操作码或任务 ${normalized}`);setCode("");
  },[scan,selectAction,selectItem,workItems]);

  useEffect(()=>{
    const normalized=code.trim();
    if(pending||normalized.length<4)return;
    const timer=window.setTimeout(()=>{if(snapshot)selectScannedCode(normalized);else void scan(normalized)},320);
    return()=>window.clearTimeout(timer);
  },[code,pending,scan,selectScannedCode,snapshot]);

  const submit=(event:FormEvent)=>{event.preventDefault();const normalized=code.trim();if(!normalized)return;if(snapshot)selectScannedCode(normalized);else void scan(normalized)};
  const confirmSelection=()=>{
    if(!selection||pending)return;
    if(!snapshot||selectionContextRef.current!==selectionContext(snapshot)){
      setError("员工状态已变化，请重新选择操作后确认。");return;
    }
    if(selection.projectId&&![...(workItems?.currentWaves??[]),...(workItems?.standardTasks??[])].some(item=>item.id===selection.projectId)){
      setError("所选任务已不可用，请重新选择。");return;
    }
    if(selection.confirmMessage&&!window.confirm(selection.confirmMessage))return;
    void scan(selection.code,selection.extra);
  };

  return <div className="time-page time-scan-page">
    {titleTarget&&createPortal(<div className="time-scan-titlebar">
      <form className="time-scan-title-input" onSubmit={submit}><input ref={inputRef} className={!snapshot?"time-employee-id-entry":undefined} type="text" value={code} onChange={event=>setCode(event.target.value)} placeholder={pending?"识别中…":snapshot?"扫描操作码或任务条码":"扫描员工卡"} autoComplete="off" autoCapitalize="characters" spellCheck={false} data-1p-ignore="true" data-lpignore="true" aria-label="扫描内容"/></form>
      <button className="time-secondary" disabled={!snapshot} onClick={()=>{employeeRef.current=null;requestRef.current++;setSnapshot(null);setSelection(null);setCode("");requestAnimationFrame(()=>inputRef.current?.focus())}}>切换员工</button>
    </div>,titleTarget)}
    {error&&<div className="time-error">{error}</div>}

    <div className="time-scan-grid">
      <section className="time-card time-current-worker">
        <div className="time-card-title"><div><h3>当前状态</h3><p>系统时间为美东时间</p></div><span className={`time-state ${snapshot?.state??"off"}`}>{snapshot?stateLabel(snapshot.state):"等待员工"}</span></div>
        <dl><div><dt>Sign In</dt><dd>{snapshot?formatClock(snapshot.shift?.clockIn):"—"}</dd></div><div><dt>今日在岗</dt><dd>{snapshot?formatDurationWithSeconds(snapshot.today.onDutyMs+(snapshot.shift&&snapshot.shift.workDate===workDate()?snapshotElapsed:0)):"—"}</dd></div><div><dt>今日工作</dt><dd>{snapshot?formatDurationWithSeconds(snapshot.today.productiveMs+(snapshot.shift&&snapshot.state==="working"&&snapshot.shift.workDate===workDate()?snapshotElapsed:0)):"—"}</dd></div></dl>
        <div className="time-current-employee"><small>姓名</small><b>{snapshot?.employee.name??"扫描员工后显示"}</b></div>
        <div className="time-current-task"><small>当前任务</small><b>{snapshot?.currentProject?`${snapshot.currentProject.code} · ${snapshot.currentProject.name}`:snapshot?"暂无任务":"扫描员工后显示"}</b>{snapshot?.currentProject?.assignmentRole?<span>{snapshot.currentProject.assignmentRole==="lead"?"主负责人":"协作人员"}</span>:snapshot?.currentProject?.workType==="standard"&&snapshot.state!=="working"?<span>已暂停</span>:null}</div>
        <div className="time-button-row"><button className={`time-success${selection?.key==="clock-in"?" selected":""}`} aria-pressed={selection?.key==="clock-in"} disabled={pending||!snapshot||Boolean(snapshot.shift)} onClick={()=>selectAction("clock-in")}>上班 / Sign In</button><button className={`time-danger${selection?.key==="clock-out"?" selected":""}`} aria-pressed={selection?.key==="clock-out"} disabled={pending||!snapshot?.shift} onClick={()=>selectAction("clock-out")}>下班 / Sign Out</button><button className={`time-warning${selection?.key==="complete"?" selected":""}`} aria-pressed={selection?.key==="complete"} disabled={pending||!currentLeadWave||!snapshot?.shift} onClick={()=>selectAction("complete")}>完结当前波次</button></div>
        <button className="time-confirm-button" type="button" disabled={pending||!selection} onClick={confirmSelection}><b>确认 / CONFIRM</b><span>{selection?.label??"请先选择操作或任务"}</span></button>
        <div className="time-current-history"><div><b>今日记录</b>{snapshot&&<span>{employeeOperations.length} 条</span>}</div>{snapshot?(employeeOperations.length?<ul>{employeeOperations.map(item=><li key={item.id}><time>{formatClockWithSeconds(item.time)}</time><span>{item.message}</span></li>)}</ul>:<p>今天尚无操作记录</p>):<p>扫描员工后显示当天记录</p>}</div>
      </section>
      <section className="time-card time-task-picker">
        <div className="time-card-title"><div><h3>选择任务</h3><p>只有在岗员工可以开始计时</p></div></div>
        <h4>固定任务</h4><div className="time-task-buttons">{workItems?.standardTasks.map(item=>{const isCurrent=snapshot?.currentProject?.id===item.id;const selected=selection?.projectId===item.id;return <button type="button" key={item.id} className={[isCurrent?"current":"",selected?"selected":""].filter(Boolean).join(" ")||undefined} aria-current={isCurrent?"true":undefined} aria-pressed={selected} disabled={pending||!snapshot} onClick={()=>selectItem(item)}><b>{item.name}</b><span>{snapshot?.shift?item.code:snapshot?`Sign In · ${item.code}`:"扫描员工后可用"}</span></button>})}{workItems&&workItems.standardTasks.length===0&&<p className="time-empty">暂无固定任务</p>}</div>
        <h4>当前波次</h4><ScanWaveTable elapsed={elapsed} sortState={sortState} setSortState={setSortState} items={workItems?.currentWaves??[]} currentProjectId={snapshot?.currentProject?.id??null} selectedProjectId={selection?.projectId??null} disabled={pending||!snapshot} selectItem={selectItem}/>{workItems&&workItems.currentWaves.length===0&&<p className="time-empty">暂无当前波次</p>}
      </section>
    </div>

    <section className="time-card time-scan-log"><div className="time-card-title"><div><h3>今日操作</h3><p>显示今天全部操作记录，共 {workItems?.todayOperations.length??0} 条</p></div></div>{workItems?.todayOperations.length?<ul>{workItems.todayOperations.map(item=><li key={item.id} className={item.tone}><time>{formatClockWithSeconds(item.time)}</time><b>{item.employeeName}</b><span>{item.message}</span><small>{item.operator}</small></li>)}</ul>:<p className="time-empty">今天尚无操作记录</p>}</section>
  </div>;
}

function ScanWaveTable({elapsed,items,sortState,setSortState,currentProjectId,selectedProjectId,disabled,selectItem}:{elapsed:number;items:WorkItem[];sortState:ScanWaveSortState;setSortState:Dispatch<SetStateAction<ScanWaveSortState>>;currentProjectId:number|null;selectedProjectId:number|null;disabled:boolean;selectItem:(item:WorkItem)=>void}){
  if(!items.length)return null;
  const changeSort=(key:ScanWaveSortKey)=>setSortState(current=>({key,descending:current.key===key?!current.descending:false}));
  const sortHead=(key:Exclude<ScanWaveSortKey,"default">,label:string)=>{
    const active=sortState.key===key;
    return <th aria-sort={active?(sortState.descending?"descending":"ascending"):"none"}><button type="button" className="time-sort" aria-label={`按${label}排序`} onClick={()=>changeSort(key)}><span>{label}</span><i aria-hidden="true">{active?(sortState.descending?"↓":"↑"):"↕"}</i></button></th>;
  };
  const orderedItems=sortState.key==="default"?items:[...items].sort((left,right)=>{
    const a=scanWaveSortValue(left,sortState.key),b=scanWaveSortValue(right,sortState.key);
    const result=typeof a==="number"&&typeof b==="number"?a-b:String(a).localeCompare(String(b),"zh-CN",{numeric:true,sensitivity:"base"});
    return sortState.descending?-result:result;
  });
  return <div className="time-table-wrap time-scan-wave-wrap"><table className="time-table time-scan-wave-table"><thead><tr>{sortHead("channel","渠道")}{sortHead("type","类型")}{sortHead("waveNo","波次号")}{sortHead("state","状态")}<th>SKU</th><th>订单</th><th>件数</th><th>负责人</th>{sortHead("duration","波次工时")}</tr></thead><tbody>{orderedItems.map(item=>{const lead=item.participants.find(person=>person.role==="lead");const state=scanWaveState(item);const classes=[item.id===currentProjectId?"current":"",item.id===selectedProjectId?"selected":"",item.interruptedAt?"interrupted":""].filter(Boolean).join(" ");return <tr key={item.id} className={classes||undefined}><td><WaveChannelTag value={item.channelName}/></td><td><WaveTypeTag value={item.channelType}/></td><td><button type="button" className="time-scan-wave-select" disabled={disabled} onClick={()=>selectItem(item)}>{item.waveNo??item.code}</button></td><td><span className={`time-state ${item.interruptedAt?"interrupted":item.activeCount?"working":item.startedAt?"off":"ready"}`}>{state}</span></td><td>{item.skuCount}</td><td>{item.orderCount}</td><td>{item.pieceCount}</td><td>{lead?.name??"—"}</td><td><b>{formatDurationWithSeconds(item.totalMs+elapsed*item.activeCount)}</b></td></tr>})}</tbody></table></div>;
}

function scanWaveState(item:WorkItem){return item.interruptedAt?"中断":item.activeCount?"进行中":item.startedAt?"暂停":"未开始"}

function selectionContext(snapshot:EmployeeSnapshot){
  return JSON.stringify([snapshot.employee.id,snapshot.state,snapshot.shift?.id,snapshot.currentProject?.id,snapshot.currentProject?.status,snapshot.currentProject?.assignmentRole]);
}

function scanWaveSortValue(item:WorkItem,key:ScanWaveSortKey):string|number{
  switch(key){
    case "channel":return channelLabel(item.channelName);
    case "type":return waveTypeInfo(item.channelType).label;
    case "waveNo":return item.waveNo??item.code;
    case "state":return scanWaveState(item);
    case "duration":return item.totalMs;
    case "default":return item.sortOrder;
  }
}
