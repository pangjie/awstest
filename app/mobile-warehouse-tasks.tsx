"use client";

import { useRef, useState } from "react";

type TaskRow={id:string;type:"store"|"pick"|"move";status:string;priority:string;sku:string|null;palletId:string|null;fromLocation:string|null;toLocation:string|null;itemOutcome:string|null;itemNote:string|null;note:string|null};
type Outcome="completed"|"partial"|"returned";
const labels={pick:"取备货",move:"迁移备货",store:"存备货"};

export default function MobileWarehouseTasks({tasks,historyLoaded,historyError,api,refresh,openMenu}:{tasks:TaskRow[];historyLoaded:boolean;historyError:string;api:(url:string,options?:RequestInit)=>Promise<unknown>;refresh:()=>Promise<void>;openMenu:()=>void}){
  const [tab,setTab]=useState<"pending"|"processed">("pending");
  const [opened,setOpened]=useState<string|null>(null);
  const [outcome,setOutcome]=useState<Outcome|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const lock=useRef(false),scroll=useRef(0);
  const entries=new Map<string,TaskRow[]>();
  for(const row of tasks){
    // Legacy pick tasks are confirmed per pallet; a move is confirmed as a whole.
    const key=row.type==="pick"?JSON.stringify([row.id,row.palletId]):row.id;
    entries.set(key,[...(entries.get(key)??[]),row]);
  }
  const rows=opened?entries.get(opened):undefined;
  const task=rows?.[0];
  const pendingEntries=[...entries].filter(([,items])=>!isProcessed(items[0]));
  const processedEntries=[...entries].filter(([,items])=>isProcessed(items[0]));
  const visibleEntries=tab==="pending"?pendingEntries:processedEntries;
  const processed=Boolean(task&&isProcessed(task));
  const selectedOutcome=processed?(task?.itemOutcome??task?.status):outcome;
  const options:Array<{key:Outcome;label:string}>=task?.type==="pick"?[{key:"completed",label:"全部取出"},{key:"partial",label:"部分取出"},{key:"returned",label:"退回库位"}]:[{key:"completed",label:task?.type==="move"?"完成迁移":"完成入库"},{key:"returned",label:"退回"}];
  const back=()=>{setOpened(null);setOutcome(null);setError("");requestAnimationFrame(()=>window.scrollTo(0,scroll.current))};
  const submit=async()=>{
    if(!task||processed||!outcome||lock.current)return;
    lock.current=true;setBusy(true);setError("");
    try{
      await api(`/api/v1/tasks/${encodeURIComponent(task.id)}/complete`,{method:"POST",body:JSON.stringify({outcome,...(task.type==="pick"?{palletId:task.palletId}:{})})});
      setMessage(`${task.sku??labels[task.type]} · ${options.find(option=>option.key===outcome)?.label}已提交`);
      await refresh();
      back();
    }catch(e){setError(e instanceof Error?e.message:"提交失败，请重试")}
    finally{lock.current=false;setBusy(false)}
  };
  return <div className="mobile-warehouse-tasks">
    <div className="mwt-heading">{opened?<button disabled={busy} onClick={back}>‹ 返回列表</button>:<h1>备货待办</h1>}<button aria-label="打开页面菜单" disabled={busy} onClick={openMenu}>☰ 菜单</button></div>
    {message&&!opened&&<p className="mwt-success" role="status">{message}</p>}
    {error&&<p className="mwt-error" role="alert">{error}</p>}
    {historyError&&<p className="mwt-error" role="alert">{historyError} <button onClick={()=>void refresh()}>重试</button></p>}
    {!opened?<><div className="mwt-tabs" role="tablist" aria-label="备货任务状态"><button id="mwt-pending-tab" role="tab" aria-selected={tab==="pending"} aria-controls="mwt-task-panel" onClick={()=>{setTab("pending");setMessage("");setError("")}}>待处理 <span>{pendingEntries.length}</span></button><button id="mwt-processed-tab" role="tab" aria-selected={tab==="processed"} aria-controls="mwt-task-panel" onClick={()=>{setTab("processed");setMessage("");setError("")}}>已处理 {historyLoaded&&<span>{processedEntries.length}</span>}</button></div>
      <div id="mwt-task-panel" role="tabpanel" aria-labelledby={tab==="pending"?"mwt-pending-tab":"mwt-processed-tab"} aria-busy={tab==="processed"&&!historyLoaded&&!historyError}><div className="mwt-list">{visibleEntries.map(([key,items])=><button className="mwt-card" key={key} onClick={()=>{scroll.current=window.scrollY;setOpened(key);setOutcome(null);setError("");setMessage("");window.scrollTo(0,0)}}>
        <span className="mwt-card-meta"><span>{labels[items[0].type]}</span>{items[0].priority==="urgent"&&<b>紧急</b>}</span>
        {isProcessed(items[0])&&<span className="mwt-result">{resultLabel(items[0])}</span>}
        <TaskInfo row={items[0]}/>{items.length>1&&<span>另有 {items.length-1} 条明细 · 整单处理</span>}
        {items[0].itemNote&&<span className="mwt-note">{items[0].itemNote}</span>}
      </button>)}</div>{!visibleEntries.length&&(tab==="pending"||historyLoaded)&&<p className="mwt-empty">{tab==="pending"?"当前没有待处理任务":"暂无已处理任务"}</p>}</div>
    </>:!task?<div className="mwt-empty">该待办已被处理或已不再可用。<button onClick={back}>返回列表</button></div>:<>
      <p className="mwt-kind">{labels[task.type]}{processed?` · ${resultLabel(task)}`:rows.length>1?" · 以下明细将整单提交":""}</p>
      {rows.map((row,index)=><section className="mwt-detail" key={row.palletId??index}><TaskInfo row={row}/>
        {(row.itemNote||row.note)&&<p className="mwt-note">备注：{row.itemNote||row.note}</p>}
      </section>)}
      <div className="mwt-options" role="group" aria-label={processed?"处理结果":"选择处理结果"}>{options.map(option=><button key={option.key} disabled={busy||processed} aria-pressed={selectedOutcome===option.key} className={`mwt-${option.key}${selectedOutcome===option.key?" selected":""}`} onClick={()=>setOutcome(option.key)}><span className="mwt-selection-mark" aria-hidden="true"/>{option.label}</button>)}</div>
      <div className="mwt-confirm"><button disabled={processed||!outcome||busy} onClick={()=>void submit()}>{processed?resultLabel(task):busy?"正在提交…":outcome?`确认 · ${options.find(option=>option.key===outcome)?.label}`:"请先选择处理结果"}</button></div>
    </>}
  </div>;
}

function isProcessed(row:TaskRow){return Boolean(row.itemOutcome)||!["pending","claimed"].includes(row.status)}

function resultLabel(row:TaskRow){
  const result=row.itemOutcome??row.status;
  if(result==="completed")return row.type==="pick"?"全部取出":row.type==="move"?"完成迁移":"完成入库";
  if(result==="partial")return "部分取出";
  if(result==="returned")return row.type==="pick"?"退回库位":"已退回";
  return result==="cancelled"?"已取消":"已处理";
}

function TaskInfo({row}:{row:TaskRow}){
  return <span className="mwt-info">
    <span className="mwt-info-row"><span className="mwt-info-label">SKU</span><b>{row.sku??"未标注 SKU"}</b></span>
    <span className="mwt-info-row"><span className="mwt-info-label">{row.type==="store"?"起始库位":"备货库位"}</span><b>{row.fromLocation??"收货暂存区"}</b></span>
    <span className="mwt-info-row"><span className="mwt-info-label">{row.type==="pick"?"拣货库位":row.type==="move"?"目标备货库位":"备货库位"}</span><b>{row.toLocation??"待分配"}</b></span>
  </span>;
}
