"use client";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { t, useLanguage } from "@/app/ui-language";
import { addDays, monthRange, workDate } from "@/lib/timekeeping/time";
import { statisticsRange, STATS_MAX_RECORDS, type StatsInput, type StatsPage, type StatisticsResult } from "@/lib/timekeeping/statistics";
import { timeApi } from "./api";
import { createPortal } from "react-dom";
const duration=(ms:number)=>{const minutes=Math.floor(ms/60000);return `${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")}`};
import "./statistics.css";
import StatisticsPie, { projectColor } from "./statistics-pie";

type Column<T>={label:string;value:(row:T)=>string|number;render?:(row:T)=>ReactNode};
function DataTable<T>({columns,rows,onRow,compact=false,paginate=true,expanded=false}:{expanded?:boolean;paginate?:boolean;compact?:boolean;columns:Column<T>[];rows:T[];onRow?:(row:T)=>void}){
  const [sort,setSort]=useState({index:-1,descending:false});const [page,setPage]=useState(0);
  const ordered=useMemo(()=>sort.index<0||sort.index>=columns.length?rows:rows.toSorted((a,b)=>{
    const x=columns[sort.index].value(a),y=columns[sort.index].value(b);
    return (typeof x==="number"&&typeof y==="number"?x-y:String(x).localeCompare(String(y),"zh-CN"))*(sort.descending?-1:1);
  }),[rows,columns,sort]);
  const pages=Math.max(1,Math.ceil(rows.length/100)),current=Math.min(page,pages-1);
  return <><div className={`stats-table${compact?" stats-table-compact":""}${expanded?" stats-table-expanded":""}`}><table><thead><tr>{columns.map((c,i)=><th key={i} aria-sort={sort.index===i?(sort.descending?"descending":"ascending"):"none"}><button onClick={()=>{setSort({index:i,descending:sort.index===i&&!sort.descending});setPage(0)}}>{t(c.label)} <span>{sort.index===i?(sort.descending?"▼":"▲"):"↕"}</span></button></th>)}</tr></thead><tbody>{(paginate?ordered.slice(current*100,(current+1)*100):ordered).map((r,i)=><tr key={i}>{columns.map((c,j)=><td key={j}>{onRow&&j===0?<button className="stats-link" onClick={()=>onRow(r)}>{c.render?c.render(r):c.value(r)}</button>:c.render?c.render(r):c.value(r)}</td>)}</tr>)}</tbody></table>{!rows.length&&<p>{t("暂无记录")}</p>}</div>{paginate&&<div className="stats-pagination"><span>{rows.length} {t("条记录")} · {current+1}/{pages}</span><button disabled={!current} onClick={()=>setPage(current-1)}>{t("上一页")}</button><button disabled={current===pages-1} onClick={()=>setPage(current+1)}>{t("下一页")}</button></div>}</>;
}
const number=(v:number|null)=>v===null?"—":v.toLocaleString(undefined,{maximumFractionDigits:2});
const percent=(a:number,b:number)=>b?`${(100*a/b).toFixed(1)}%`:"—";

export default function StatisticsPage({result,setResult,titleTarget}:{titleTarget:HTMLDivElement|null;result:StatisticsResult|null;setResult:Dispatch<SetStateAction<StatisticsResult|null>>}){
  useLanguage();
  const today=workDate(),yesterday=addDays(today,-1),lastMonth=monthRange(monthRange(undefined,today).previous);
  const [start,setStart]=useState(result?.startDate??lastMonth.startDate),[end,setEnd]=useState(result?.endDate??lastMonth.endDate);
  const [tab,setTab]=useState(0),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState(""),[progress,setProgress]=useState("");
  const [employee,setEmployee]=useState("");
  const controller=useRef<AbortController|null>(null),worker=useRef<Worker|null>(null);
  useEffect(()=>()=>{controller.current?.abort();worker.current?.terminate()},[]);
  async function query(){
    if(busy)return;
    try{statisticsRange(start,end)}catch(e){setError((e as Error).message);return}
    setBusy(true);setError("");setResult(null);
    const abort=new AbortController();controller.current=abort;
    try{
      const input:StatsInput={startDate:start,endDate:end,generatedAt:"",employees:[],shifts:[],sessions:[],items:[]};
      const items=new Map<number,StatsInput["items"][number]>();
      let cursor:string|null=start,revision:string|undefined;
      while(cursor){
        setProgress(cursor);
        const params=new URLSearchParams({startDate:start,endDate:end,cursor});if(revision)params.set("revision",revision);
        if(input.snapshotAt)params.set("snapshotAt",input.snapshotAt);
        const page:StatsPage=await timeApi(`/api/v1/timekeeping/statistics?${params}`,{signal:abort.signal});
        if(input.snapshotAt&&input.snapshotAt!==page.snapshotAt)throw new Error("统计截止时间发生变化，请重新查询");
        input.snapshotAt=page.snapshotAt;
        revision=page.revision;cursor=page.next;input.generatedAt=page.generatedAt;
        input.employees.push(...page.employees);input.shifts.push(...page.shifts);input.sessions.push(...page.sessions);page.items.forEach(i=>items.set(i.id,i));
        if(input.sessions.length>STATS_MAX_RECORDS||input.shifts.length>STATS_MAX_RECORDS||items.size>STATS_MAX_RECORDS)throw new Error("数据量过大，请缩短日期范围");
      }
      input.items=[...items.values()];
      if(abort.signal.aborted)return;
      worker.current=new Worker(new URL("./statistics.worker.ts",import.meta.url),{type:"module"});
      const next=await new Promise<StatisticsResult>((resolve,reject)=>{
        const cancel=()=>reject(new Error("查询已取消"));
        abort.signal.addEventListener("abort",cancel,{once:true});
        worker.current!.onmessage=event=>{abort.signal.removeEventListener("abort",cancel);if(event.data.error)reject(new Error(event.data.error));else resolve(event.data.result)};
        worker.current!.onerror=()=>{abort.signal.removeEventListener("abort",cancel);reject(new Error("统计计算失败，请缩短日期范围重试"))};
        worker.current!.postMessage(input);
      });
      if(!abort.signal.aborted){setResult(next);setEmployee("")}
    }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:"读取失败")}
    finally{worker.current?.terminate();worker.current=null;if(!abort.signal.aborted){setBusy(false);setProgress("")}}
  }
  async function download(){
    if(!result||exporting)return;setExporting(true);setError("");
    try{const [{downloadWorkbook},{statisticsSheets}]=await Promise.all([import("@/lib/excel-workbook"),import("./statistics-export")]);await downloadWorkbook({fileName:`综合统计-${result.startDate}-${result.endDate}.xlsx`,sheets:statisticsSheets(result)})}
    catch(e){setError(e instanceof Error?e.message:"导出失败")}finally{setExporting(false)}
  }
  const people=result?.people??[],personById=new Map(people.map(p=>[p.id,p]));
  function quick(which:string){
    if(which==="today"){setStart(today);setEnd(today)}
    if(which==="yesterday"){setStart(yesterday);setEnd(yesterday)}
    if(which==="month"){setStart(lastMonth.startDate);setEnd(lastMonth.endDate)}
    if(which==="current"){setStart(`${today.slice(0,7)}-01`);setEnd(today)}
    if(which==="week"){const weekday=new Date(`${today}T12:00Z`).getUTCDay();const monday=addDays(today,-((weekday+6)%7));setStart(addDays(monday,-7));setEnd(addDays(monday,-1))}
  }
  const totals=result?.totals;
  const toolbar=<div className="stats-toolbar stats-title-toolbar"><label>{t("起始日期")}<input type="date" value={start} max={end} onChange={e=>setStart(e.target.value)}/></label><label>{t("终止日期")}<input type="date" value={end} min={start} max={today} onChange={e=>setEnd(e.target.value)}/></label><button className="primary" disabled={busy} onClick={()=>void query()}>{busy?`${t("读取中")} ${progress}`:t("查询")}</button><button disabled={!result||busy||exporting} onClick={()=>void download()}>{exporting?t("导出中"):t("导出完整 Excel")}</button><div className="stats-shortcuts">{[["today","今天"],["yesterday","昨天"],["week","上周"],["month","上月"],["current","本月至今天"]].map(([k,label])=><button key={k} disabled={busy} onClick={()=>quick(k)}>{t(label)}</button>)}</div></div>;
  return <div className="statistics-page">
    {titleTarget?createPortal(toolbar,titleTarget):toolbar}
    {error&&<p role="alert" className="stats-error">{error}</p>}
    {!result&&!busy&&<p className="stats-note">{t("可查询截至今天的数据；单次最多三个自然月，计算在浏览器完成。")}</p>}
    {result&&totals&&<>
      {(start!==result.startDate||end!==result.endDate)&&<p className="stats-note">{t("日期已修改，请重新查询")}</p>}
      {result.isSnapshot&&<p className="stats-warning">{t("包含当日快照，时效为暂估；结果固定至查询截止时间，再次查询才更新。")}</p>}
      <div className="stats-tabs" role="tablist">{["项目与类型汇总","员工汇总","详细记录"].map((label,i)=><button role="tab" aria-selected={tab===i} key={label} onClick={()=>setTab(i)}>{t(label)}</button>)}</div>
      {result.issues.length>0&&<details className="stats-warning"><summary>{t("统计待核对")} · {result.issues.length} {t("条异常；以下为部分有效记录统计")}</summary><DataTable rows={result.issues} columns={[{label:"日期",value:r=>r.date},{label:"姓名",value:r=>r.employeeId===null?"—":personById.get(r.employeeId)?.name??"—"},{label:"任务",value:r=>r.task},{label:"说明",value:r=>r.message}]}/></details>}
      {tab===0&&<>
        <div className="stats-overview">{[["自然日数",totals.calendarDays],["实际工作日",totals.workDays],["出勤人天",totals.personDays],["完成波次数",totals.waves],["订单数",totals.orders],["件数",totals.pieces],["在岗时长",duration(totals.onDutyMs)],["工作时长",duration(totals.workMs)],["在岗待命",duration(totals.standbyMs)],["总体拣货效率",number(totals.overallEfficiency)],["工作时间占比",percent(totals.workMs,totals.onDutyMs)]].map(([label,value])=><div key={label}><span>{t(String(label))}</span><strong>{value}</strong></div>)}</div>
        <h3>{t("项目工时")}</h3><div className="stats-project-layout"><div className="stats-project-table"><DataTable compact paginate={false} rows={result.projects} columns={[{label:"项目",value:r=>r.name,render:r=><span className="stats-project-name"><i aria-hidden="true" style={{background:projectColor(result.projects.indexOf(r))}}/>{t(r.name)}</span>},{label:"总用时",value:r=>r.ms,render:r=>duration(r.ms)},{label:"参与人次",value:r=>r.count},{label:"工时占比",value:r=>r.ms,render:r=>percent(r.ms,totals.onDutyMs)}]}/>{totals.onDutyMs>result.projects.reduce((sum,p)=>sum+p.ms,0)&&<p className="stats-project-unclassified"><span className="stats-project-name"><i aria-hidden="true" style={{background:"#d4dce6"}}/>{t("未归类在岗时间")}</span><strong>{percent(totals.onDutyMs-result.projects.reduce((sum,p)=>sum+p.ms,0),totals.onDutyMs)}</strong></p>}</div><StatisticsPie projects={result.projects} total={totals.onDutyMs}/></div>
        <h3>{t("波次类型汇总")}</h3><DataTable compact paginate={false} rows={result.types} columns={[{label:"类型",value:r=>r.name,render:r=>t(r.name)},{label:"波次数",value:r=>r.waves},{label:"订单数",value:r=>r.orders},{label:"件数",value:r=>r.pieces},{label:"拣货用时",value:r=>r.pickMs,render:r=>duration(r.pickMs)},{label:"扫描用时",value:r=>r.scanMs,render:r=>["爆品","多件"].includes(r.name)?"0":duration(r.scanMs)},{label:"拣货时效",value:r=>r.pickRate??-1,render:r=>number(r.pickRate)},{label:"扫描时效",value:r=>r.scanRate??-1,render:r=>number(r.scanRate)},{label:"综合时效",value:r=>r.combinedRate??-1,render:r=>number(r.combinedRate)}]}/>
      </>}
      {tab===1&&<><DataTable compact paginate={false} expanded rows={people.filter(p=>p.days||p.issues||p.workMs)} onRow={p=>{setEmployee(String(p.id));setTab(2)}} columns={[{label:"姓名",value:p=>p.name},{label:"出勤天数",value:p=>p.days},...result.projectNames.map(n=>({label:n,value:(p:StatisticsResult["people"][number])=>p.projects[n]??0,render:(p:StatisticsResult["people"][number])=>duration(p.projects[n]??0)})),{label:"在岗待命",value:p=>p.standbyMs,render:p=>duration(p.standbyMs)},{label:"工作合计",value:p=>p.workMs,render:p=>duration(p.workMs)},{label:"工作时间占比",value:p=>p.onDutyMs?p.workMs/p.onDutyMs:0,render:p=>percent(p.workMs,p.onDutyMs)},]}/></>}
      {tab===2&&<>{employee?<><h3>{personById.get(Number(employee))?.name} · {result.startDate} — {result.endDate}</h3><DataTable compact paginate={false} expanded key={employee} rows={result.daily.filter(d=>d.employeeId===Number(employee))} columns={[{label:"日期",value:d=>d.date},{label:"姓名",value:d=>personById.get(d.employeeId)?.name??"—"},...result.projectNames.map(n=>({label:n,value:(d:StatisticsResult["daily"][number])=>d.projects[n]??0,render:(d:StatisticsResult["daily"][number])=>duration(d.projects[n]??0)})),{label:"在岗待命",value:d=>d.standbyMs,render:d=>duration(d.standbyMs)},{label:"工作时长",value:d=>d.workMs,render:d=>duration(d.workMs)}]}/></>:<p className="stats-note">{t("请在员工汇总中点击姓名，查看该员工的每日汇总。")}</p>}</>}
    </>}
  </div>;
}
