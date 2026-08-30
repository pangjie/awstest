"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { timeApi } from "./api";
import { formatClock, formatClockWithSeconds, formatDurationWithSeconds, stateLabel } from "./format";
import type { EmployeeSnapshot, ScanResponse, WorkItem, WorkItemsResponse } from "./types";
import { WaveChannelTag, WaveTypeTag } from "./wave-display";

export default function ScanPage({titleTarget}:{titleTarget:HTMLDivElement|null}){
  const [code,setCode]=useState("");
  const [snapshot,setSnapshot]=useState<EmployeeSnapshot|null>(null);
  const [workItems,setWorkItems]=useState<WorkItemsResponse|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const inputRef=useRef<HTMLInputElement>(null);

  const loadWorkItems=useCallback(async()=>{try{setWorkItems(await timeApi<WorkItemsResponse>("/api/v1/timekeeping/scan"))}catch(loadError){setError(loadError instanceof Error?loadError.message:"任务数据读取失败")}},[]);
  useEffect(()=>{let cancelled=false;void timeApi<WorkItemsResponse>("/api/v1/timekeeping/scan").then(next=>{if(!cancelled)setWorkItems(next)}).catch(loadError=>{if(!cancelled)setError(loadError instanceof Error?loadError.message:"任务数据读取失败")});return()=>{cancelled=true}},[]);
  useEffect(()=>{inputRef.current?.focus()},[snapshot,titleTarget]);

  const scan=useCallback(async(scannedCode:string,extra:Record<string,unknown>={})=>{
    const normalized=scannedCode.trim();
    if(!normalized||pending)return;
    setPending(true);setError("");
    try{
      const response=await timeApi<ScanResponse>("/api/v1/timekeeping/scan",{method:"POST",body:JSON.stringify({code:normalized,employeeId:snapshot?.employee.id,requestId:crypto.randomUUID(),terminalId:"browser-main",...extra})});
      if(response.snapshot)setSnapshot(response.snapshot);
      await loadWorkItems();
    }catch(scanError){setError(scanError instanceof Error?scanError.message:"扫描操作失败")}
    finally{setPending(false);setCode("");requestAnimationFrame(()=>inputRef.current?.focus())}
  },[loadWorkItems,pending,snapshot]);

  useEffect(()=>{
    const normalized=code.trim();
    if(pending||normalized.length<4)return;
    const timer=window.setTimeout(()=>void scan(normalized),320);
    return()=>window.clearTimeout(timer);
  },[code,pending,scan]);

  const submit=(event:FormEvent)=>{event.preventDefault();void scan(code)};
  const currentLeadWave=snapshot?.currentProject?.workType==="wave"&&snapshot.currentProject.assignmentRole==="lead"&&snapshot.currentProject.status==="active"?snapshot.currentProject:null;
  const employeeOperations=snapshot?workItems?.todayOperations.filter(item=>item.employeeId===snapshot.employee.id)??[]:[];
  const startItem=(item:{id:number;code:string})=>{
    if(currentLeadWave&&currentLeadWave.id!==item.id){if(!window.confirm(`完结波次 ${currentLeadWave.waveNo??currentLeadWave.code} 并切换到新任务？`))return;void scan(item.code,{completeProjectId:currentLeadWave.id});return}
    if(snapshot?.shift)void scan(item.code);else void scan("ACT-CLOCKIN",{projectCode:item.code});
  };

  return <div className="time-page time-scan-page">
    {titleTarget&&createPortal(<div className="time-scan-titlebar">
      <form className="time-scan-title-input" onSubmit={submit}><input ref={inputRef} type={snapshot?"text":"password"} value={code} onChange={event=>setCode(event.target.value)} placeholder={pending?"识别中…":snapshot?"扫描操作码或任务条码":"扫描员工卡"} autoComplete="off" aria-label="扫描内容"/></form>
      <button className="time-secondary" disabled={!snapshot} onClick={()=>{setSnapshot(null);setCode("")}}>切换员工</button>
    </div>,titleTarget)}
    {error&&<div className="time-error">{error}</div>}

    <div className="time-scan-grid">
      <section className="time-card time-current-worker">
        <div className="time-card-title"><div><h3>当前状态</h3><p>系统时间为美东时间</p></div><span className={`time-state ${snapshot?.state??"off"}`}>{snapshot?stateLabel(snapshot.state):"等待员工"}</span></div>
        <dl><div><dt>Sign In</dt><dd>{snapshot?formatClock(snapshot.shift?.clockIn):"—"}</dd></div><div><dt>今日在岗</dt><dd>{snapshot?formatDurationWithSeconds(snapshot.today.onDutyMs):"—"}</dd></div><div><dt>今日工作</dt><dd>{snapshot?formatDurationWithSeconds(snapshot.today.productiveMs):"—"}</dd></div></dl>
        <div className="time-current-employee"><small>姓名</small><b>{snapshot?.employee.name??"扫描员工后显示"}</b></div>
        <div className="time-current-task"><small>当前任务</small><b>{snapshot?.currentProject?`${snapshot.currentProject.code} · ${snapshot.currentProject.name}`:snapshot?"暂无任务":"扫描员工后显示"}</b>{snapshot?.currentProject?.assignmentRole&&<span>{snapshot.currentProject.assignmentRole==="lead"?"主负责人":"协作人员"}</span>}</div>
        <div className="time-button-row"><button className="time-success" disabled={pending||!snapshot||Boolean(snapshot.shift)} onClick={()=>void scan("ACT-CLOCKIN")}>上班 / Sign In</button><button className="time-danger" disabled={pending||!snapshot?.shift} onClick={()=>void scan("ACT-OUT")}>下班 / Sign Out</button><button className="time-warning" disabled={pending||!currentLeadWave||!snapshot?.shift} onClick={()=>void scan("ACT-WAVE-COMPLETE",{completeProjectId:currentLeadWave?.id})}>完结当前波次</button></div>
        <div className="time-current-history"><div><b>今日记录</b>{snapshot&&<span>{employeeOperations.length} 条</span>}</div>{snapshot?(employeeOperations.length?<ul>{employeeOperations.map(item=><li key={item.id}><time>{formatClockWithSeconds(item.time)}</time><span>{item.message}</span></li>)}</ul>:<p>今天尚无操作记录</p>):<p>扫描员工后显示当天记录</p>}</div>
      </section>
      <section className="time-card time-task-picker">
        <div className="time-card-title"><div><h3>选择任务</h3><p>只有在岗员工可以开始计时</p></div></div>
        <h4>固定任务</h4><div className="time-task-buttons">{workItems?.standardTasks.map(item=>{const isCurrent=snapshot?.currentProject?.id===item.id;return <button type="button" key={item.id} className={isCurrent?"current":undefined} aria-current={isCurrent?"true":undefined} disabled={pending||!snapshot} onClick={()=>startItem(item)}><b>{item.name}</b><span>{snapshot?.shift?item.code:snapshot?`Sign In · ${item.code}`:"扫描员工后可用"}</span></button>})}{workItems&&workItems.standardTasks.length===0&&<p className="time-empty">暂无固定任务</p>}</div>
        <h4>当前波次</h4><ScanWaveTable items={workItems?.currentWaves??[]} currentProjectId={snapshot?.currentProject?.id??null} disabled={pending||!snapshot} startItem={startItem}/>{workItems&&workItems.currentWaves.length===0&&<p className="time-empty">暂无当前波次</p>}
      </section>
    </div>

    <section className="time-card time-scan-log"><div className="time-card-title"><div><h3>今日操作</h3><p>显示今天全部扫码台操作，共 {workItems?.todayOperations.length??0} 条</p></div></div>{workItems?.todayOperations.length?<ul>{workItems.todayOperations.map(item=><li key={item.id} className={item.tone}><time>{formatClockWithSeconds(item.time)}</time><b>{item.employeeName}</b><span>{item.message}</span><small>{item.operator}</small></li>)}</ul>:<p className="time-empty">今天尚无操作记录</p>}</section>
  </div>;
}

function ScanWaveTable({items,currentProjectId,disabled,startItem}:{items:WorkItem[];currentProjectId:number|null;disabled:boolean;startItem:(item:{id:number;code:string})=>void}){
  if(!items.length)return null;
  return <div className="time-table-wrap time-scan-wave-wrap"><table className="time-table time-scan-wave-table"><thead><tr><th>渠道</th><th>类型</th><th>波次号</th><th>状态</th><th>SKU</th><th>订单</th><th>件数</th><th>负责人</th><th>波次工时</th></tr></thead><tbody>{items.map(item=>{const lead=item.participants.find(person=>person.role==="lead");const state=item.activeCount?"进行中":item.startedAt?"暂停":"未开始";return <tr key={item.id} className={item.id===currentProjectId?"current":undefined}><td><WaveChannelTag value={item.channelName}/></td><td><WaveTypeTag value={item.channelType}/></td><td><button type="button" className="time-scan-wave-select" disabled={disabled} onClick={()=>startItem(item)}>{item.waveNo??item.code}</button></td><td><span className={`time-state ${item.activeCount?"working":item.startedAt?"off":"ready"}`}>{state}</span></td><td>{item.skuCount}</td><td>{item.orderCount}</td><td>{item.pieceCount}</td><td>{lead?.name??"—"}</td><td><b>{formatDurationWithSeconds(item.totalMs)}</b></td></tr>})}</tbody></table></div>;
}
