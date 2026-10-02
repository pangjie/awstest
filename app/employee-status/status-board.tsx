"use client";
import { t, useLanguage, taskText } from "@/app/ui-language";

import { useEffect,useState } from "react";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { EMPLOYEE_STATUS_LABELS,employeeTaskStyle,statusClock,type StatusSnapshot,type StatusEmployee } from "@/lib/employee-status";

type CardChange={sequence:number;kind:"flip"|"sheen";previous:StatusEmployee;startedAt:number};

export default function EmployeeStatusBoard(){
  useLanguage();
  const [snapshot,setSnapshot]=useState<StatusSnapshot|null>(null);
  const [now,setNow]=useState<number|null>(null);
  const [lastSync,setLastSync]=useState<number|null>(null);
  const [error,setError]=useState("");
  const [blocked,setBlocked]=useState(false);
  const [fullscreenError,setFullscreenError]=useState("");
  const [changes,setChanges]=useState<Record<number,CardChange>>({});

  useEffect(()=>{
    let disposed=false,busy=false,initial=true,stopped=false,wasActive=false;
    let revision:number|null=null,date="",offset=0,failures=0;
    let poll:number|undefined;
    let controller:AbortController|null=null;
    let previous:StatusSnapshot|null=null,suppressAnimation=false,changeSequence=0;
    let changeMarks:Record<number,CardChange>={};
    const tick=async()=>{
      if(disposed||stopped||busy)return;
      window.clearTimeout(poll);
      const current=Date.now()+offset;
      setNow(current);
      const clock=statusClock(current);
      if(!clock.active)wasActive=false;
      if(document.visibilityState!=="visible"||(!initial&&!clock.active)){
        poll=window.setTimeout(()=>void tick(),1_000);return;
      }
      const fresh=initial||revision===null||date!==clock.date||!wasActive||suppressAnimation;
      initial=false;busy=true;wasActive=clock.active;
      const requestController=new AbortController();
      controller=requestController;
      try{
        const options={cache:"no-store" as const,signal:requestController.signal};
        let response:Response;
        if(fresh){
          response=await fetchWithTimeout("/api/v1/timekeeping/employee-status",options);
        }else{
          response=await fetchWithTimeout("/api/v1/timekeeping/revision?scope=employee-status",{...options,headers:{"if-none-match":`"${revision}"`}});
          if(response.ok){
            // Do not start another request after the daily sync window closes.
            if(disposed||requestController.signal.aborted||!statusClock(Date.now()+offset).active)return;
            response=await fetchWithTimeout("/api/v1/timekeeping/employee-status",options);
          }
        }
        if(disposed||requestController.signal.aborted)return;
        if(response.status===401||response.status===403){
          stopped=true;setBlocked(true);setSnapshot(null);
          setError(response.status===401?"登录已失效，请重新登录":"员工状态访问权限已被取消");return;
        }
        if(response.status!==304){
          if(!response.ok)throw new Error("状态读取失败");
          const data=await response.json() as StatusSnapshot;
          if(disposed||requestController.signal.aborted)return;
          const before=new Map(previous?.employees.map(employee=>[employee.id,employee]));
          const animate=!fresh&&!suppressAnimation&&previous?.date===data.date;
          const nextMarks:Record<number,CardChange>={};
          for(const employee of data.employees){
            const old=before.get(employee.id);
            if(animate&&old&&(old.state!==employee.state||old.task!==employee.task)){
              const running=changeMarks[employee.id];
              // While airborne, update the destination face rather than queueing obsolete states.
              nextMarks[employee.id]=running?.kind==="flip"&&Date.now()-running.startedAt<750?running:{
                sequence:++changeSequence,kind:EMPLOYEE_STATUS_LABELS[old.state]!==EMPLOYEE_STATUS_LABELS[employee.state]?"flip":"sheen",
                previous:old,startedAt:Date.now(),
              };
            }
            else if(animate&&changeMarks[employee.id])nextMarks[employee.id]=changeMarks[employee.id];
          }
          changeMarks=nextMarks;setChanges(nextMarks);
          previous=data;suppressAnimation=false;
          revision=data.revision;date=data.date;
          offset=new Date(data.generatedAt).getTime()-Date.now();
          setSnapshot(data);
        }
        failures=0;setError("");setLastSync(Date.now()+offset);
      }catch{
        if(!disposed&&!requestController.signal.aborted){
          failures++;suppressAnimation=true;setError("连接异常，数据可能已过期");
        }
      }finally{
        controller=null;
        busy=false;
        if(!disposed&&!stopped)poll=window.setTimeout(()=>void tick(),[1_000,2_000,5_000,10_000,30_000][Math.min(failures,4)]);
      }
    };
    const timer=window.setInterval(()=>setNow(Date.now()+offset),1_000);
    const visible=()=>{
      if(document.visibilityState!=="visible"){
        suppressAnimation=true;changeMarks={};setChanges({});controller?.abort();return;
      }
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange",visible);
    return()=>{disposed=true;controller?.abort();window.clearInterval(timer);window.clearTimeout(poll);document.removeEventListener("visibilitychange",visible)};
  },[]);

  async function fullscreen(){
    try{
      if(!document.documentElement.requestFullscreen)throw new Error("unsupported");
      await document.documentElement.requestFullscreen();setFullscreenError("");
    }catch{setFullscreenError("无法进入全屏，请使用浏览器的全屏功能。")}
  }

  const clock=now===null?null:statusClock(now);
  const counts={picking:0,warehouse:0,ready:0,off:0,not_started:0};
  for(const employee of snapshot?.employees??[])counts[employee.state]++;
  return <main className="employee-status-board">
    <header className="employee-status-header">
      <h1 data-ui-size="">{t("员工状态")}</h1>
      <div className="employee-status-counts">
        <span>{t("在岗")} <b>{counts.picking+counts.warehouse+counts.ready}</b></span>
        <span>{t("拣货")} <b>{counts.picking}</b></span><span>{t("仓务")} <b>{counts.warehouse}</b></span>
        <span>{t("待命")} <b>{counts.ready}</b></span><span>{t("不在岗")} <b>{counts.off+counts.not_started}</b></span>
      </div>
      <div className="employee-status-clock"><b>{clock?`${clock.date} ${clock.time}`:t("美东时间")}</b>
        <small className={error?"employee-status-warning":""}>{t(error)||(clock&&!clock.active?t("自动同步已暂停 · 每日 07:00–22:00"):snapshot?t("自动同步中"):t("正在读取员工状态"))}{lastSync!==null&&t(" · 最后同步 {0} {1}", {0: statusClock(lastSync).date, 1: statusClock(lastSync).time})}</small>
      </div>
      <button className="employee-status-fullscreen" type="button" onClick={()=>void fullscreen()} data-ui-size="">{t("全屏展示")}</button>
    </header>
    {fullscreenError&&<p role="status">{t(fullscreenError)}</p>}
    {blocked?<p role="alert">{t(error)}。<a href="/employee-status">{t("重新打开登录页面")}</a></p>:
      <section className="employee-status-grid" aria-label={t("员工状态卡片")}>
        {snapshot?.employees.map(employee=>{
          const change=changes[employee.id];
          return <div key={`${employee.id}-${change?.kind==="flip"?change.sequence:"still"}`} className="employee-card-slot">
            {change?.kind==="flip"?<div key={change.sequence} className="employee-card-flip">
              <EmployeeCard employee={change.previous} face="flip-old" hidden/>
              <EmployeeCard employee={employee} face="flip-back"/>
            </div>:<EmployeeCard employee={employee} sheen={change?.sequence}/>}
          </div>;
        })}
        {snapshot&&!snapshot.employees.length&&<p>{t("暂无启用的员工")}</p>}
      </section>}
  </main>;
}

function EmployeeCard({employee,face="",hidden=false,sheen}:{employee:StatusEmployee;face?:string;hidden?:boolean;sheen?:number}){
  useLanguage();
  return <article className={`employee-status-card state-${employee.state} ${face}`} aria-hidden={hidden||undefined}>
          {sheen&&<span key={sheen} className="employee-status-change" aria-hidden="true"/>}
          <div className="employee-card-top">
            <span className="employee-card-brand" aria-hidden="true"><TaskIcon kind="warehouse"/>{t("内库")}</span>
            <span className="employee-status-label"><b>{EMPLOYEE_STATUS_LABELS[employee.state].split(" / ")[0]}</b><small lang="es">{EMPLOYEE_STATUS_LABELS[employee.state].split(" / ")[1]}</small></span>
          </div>
          <h2 className={employee.name.length>10?"long-name":""} title={employee.name}>{employee.name}</h2>
          <div className={`employee-card-task task-${employeeTaskStyle(employee)}${employee.state==="off"?" task-paused":""}`}>
            <span className="employee-card-task-icon"><TaskIcon kind={employeeTaskStyle(employee)}/></span>
            <p title={employee.task?taskText(employee.task):undefined}>{(employee.task?taskText(employee.task):null)|| (employee.state==="ready"?t("等待任务"):employee.state==="off"?t("休息中"):t("尚未开始"))}</p>
            {employee.state==="off"&&employee.task&&<span className="employee-card-pause" aria-hidden="true">Ⅱ</span>}
          </div>
        </article>;
}

function TaskIcon({kind}:{kind:string}){
  const paths:Record<string,string>={
    warehouse:"M3 10 12 4l9 6v11H3Z M7 21v-9h10v9 M7 15h10 M7 18h10",
    wave:"m3 7 9-4 9 4v10l-9 4-9-4Z m0-0 9 4 9-4 M12 11v10 M7 5l10 4v5",
    scan:"M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M7 8v8 M10 8v8 M14 8v8 M17 8v8",
    issue:"M6 3h9l4 4v14H6Z M14 3v5h5 M12 11v4 M12 18h.01",
    clean:"m14 3-4 10 M7 12l8 3-2 6H3l4-9Z M7 16l-1 5 M10 17l-1 4 M19 3v6 M16 6h6",
    other:"M8 5H5v16h14V5h-3 M9 3h6v4H9Z M9 12h6 M9 16h4",
    idle:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]??paths.other}/></svg>;
}
