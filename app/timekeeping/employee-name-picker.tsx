"use client";
import {useEffect,useRef,useState,type RefObject} from "react";
import {t,useLanguage} from "@/app/ui-language";
import {timeApi} from "./api";

type EmployeeOption={id:number;name:string;organization:string;badgeCode:string;legacyBadgeCode?:string};
export function matchEmployeeNames(employees:EmployeeOption[],query:string){
  const normalize=(value:string)=>value.normalize("NFD").replace(/\p{M}/gu,"").toLowerCase().trim();
  const needle=normalize(query);
  if(!needle)return [];
  return employees.filter(employee=>normalize(employee.name).includes(needle)).sort((a,b)=>a.name.localeCompare(b.name,"en")||a.id-b.id);
}

export function EmployeeNamePicker({query,setQuery,inputRef,disabled,isTaskCode,onSelect,onCode}:{query:string;setQuery:(value:string)=>void;inputRef:RefObject<HTMLInputElement|null>;disabled:boolean;isTaskCode:(value:string)=>boolean;onSelect:(badge:string)=>void;onCode:(value:string)=>void}){
  useLanguage();
  const [composing,setComposing]=useState(false);
  const handled=useRef("");
  const [open,setOpen]=useState(false);
  const [employees,setEmployees]=useState<EmployeeOption[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let cancelled=false;
    // Each effect setup owns its request, including Strict Mode's cleanup/restart.
    void timeApi<{employees:EmployeeOption[]}>("/api/v1/timekeeping/scan?lookup=employees")
      .then(data=>{if(!cancelled)setEmployees(data.employees)})
      .catch(()=>{if(!cancelled)setError("员工姓名读取失败，请重新点击输入框重试")})
      .finally(()=>{if(!cancelled)setLoading(false)});
    return()=>{cancelled=true};
  },[retry]);
  const matches=matchEmployeeNames(employees,query);
  const normalized=query.trim().toUpperCase();
  const employee=employees.find(item=>[item.badgeCode,item.legacyBadgeCode].some(value=>value?.toUpperCase()===normalized));
  const exactCode=Boolean(normalized&&(employee||isTaskCode(normalized)));
  const choose=(item:EmployeeOption)=>{if(disabled||loading)return;handled.current=query;setOpen(false);onSelect(item.badgeCode)};
  useEffect(()=>{
    if(disabled||loading||composing||!exactCode||handled.current===query)return;
    const timer=window.setTimeout(()=>{if(handled.current===query)return;handled.current=query;setOpen(false);onCode(normalized)},320);
    return()=>window.clearTimeout(timer);
  },[query,normalized,disabled,loading,composing,exactCode,onCode]);
  return <div className="time-employee-name-picker" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false)}}>
    <input ref={inputRef} type="text" autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" role="combobox" aria-label={t("扫描工卡或输入姓名")} aria-expanded={open&&Boolean(query.trim())&&!exactCode&&!composing} aria-controls="employee-name-options" aria-autocomplete="list" readOnly={disabled} value={query} placeholder={t("扫描工卡或输入姓名")} onFocus={()=>{setOpen(true);if(error){setError("");setLoading(true);setRetry(value=>value+1)}}} onChange={event=>{handled.current="";setQuery(event.target.value);setOpen(true)}} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onKeyDown={event=>{
      if(event.nativeEvent.isComposing||composing||event.keyCode===229)return;
      if(event.key==="Escape")setOpen(false);
      if(event.key==="Enter"){
        event.preventDefault();if(disabled||loading)return;
        if(exactCode){handled.current=query;setOpen(false);onCode(normalized)}
        else if(matches[0])choose(matches[0]);
      }
    }}/>
    {open&&Boolean(query.trim())&&!exactCode&&!composing&&<div className="time-employee-name-options" id="employee-name-options" role="listbox">
      {error?<p role="alert">{t(error)}</p>:loading?<p>{t("读取中")}</p>:matches.length?matches.map(employee=><button type="button" role="option" aria-selected={false} key={employee.id} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(employee)}><strong>{employee.name}</strong><small>{employee.organization}</small></button>):<p>{t("没有匹配的在职员工")}</p>}
    </div>}
  </div>;
}
