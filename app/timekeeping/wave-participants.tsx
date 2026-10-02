"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, useLanguage } from "@/app/ui-language";
import { formatDurationWithSeconds } from "./format";
import type { WorkParticipant } from "./types";

export function LeadSummary({lead,helpers,openScan}:{lead:WorkParticipant|undefined;helpers:WorkParticipant[];openScan?:((badge:string)=>void)}){
  useLanguage();
  const triggerRef=useRef<HTMLButtonElement>(null);
  const hideTimerRef=useRef<number|null>(null);
  const tooltipId=useId();
  const [position,setPosition]=useState<{left:number;top:number;above:boolean}|null>(null);
  const cancelHide=()=>{if(hideTimerRef.current!==null){window.clearTimeout(hideTimerRef.current);hideTimerRef.current=null}};
  const show=()=>{
    cancelHide();
    const trigger=triggerRef.current;if(!trigger||!helpers.length)return;
    const bounds=trigger.getBoundingClientRect();
    const width=Math.min(370,window.innerWidth-24);
    const above=window.innerHeight-bounds.bottom<170&&bounds.top>170;
    setPosition({left:Math.max(12,Math.min(window.innerWidth-width-12,bounds.left+bounds.width/2-width/2)),top:above?bounds.top-8:bounds.bottom+8,above});
  };
  const hide=()=>{cancelHide();hideTimerRef.current=window.setTimeout(()=>{setPosition(null);hideTimerRef.current=null},120)};
  useEffect(()=>()=>cancelHide(),[]);
  return <div className="time-dashboard-lead-summary">{lead?<PersonTag person={lead} showDuration={false} openScan={openScan}/>:<span className="time-dashboard-person time-person-empty">—</span>}<button ref={triggerRef} className="time-dashboard-helper-trigger" type="button" aria-describedby={position?tooltipId:undefined} aria-label={helpers.length?t("协同 {0} 人：{1}", {0: helpers.length, 1: helpers.map(person=>person.name).join("、")}):t("无协同人员")} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}><b>{helpers.length}</b></button>{position&&createPortal(<div id={tooltipId} role="tooltip" className={`time-dashboard-helper-popover${position.above?" above":""}`} style={{left:position.left,top:position.top}} onMouseEnter={cancelHide} onMouseLeave={hide}><strong>{t("协同人员 ·")} {helpers.length}</strong><div>{helpers.map(person=><PersonTag person={person} openScan={openScan} key={person.employeeId}/>)}</div></div>,document.body)}</div>;
}

function PersonTag({person,showDuration=true,openScan}:{person:WorkParticipant;showDuration?:boolean;openScan?:((badge:string)=>void)}){const className=`time-dashboard-person${person.active?" active":""}`;const title=openScan?`在任务分发中打开 ${person.name}`:showDuration?`${person.name} · ${formatDurationWithSeconds(person.totalMs)}`:person.name;const content=<><i/><b>{person.name}</b>{showDuration&&<small>{formatDurationWithSeconds(person.totalMs)}</small>}</>;return openScan?<button type="button" className={className} title={title} onClick={()=>openScan(person.badgeCode)}>{content}</button>:<span className={className} title={title}>{content}</span>}
