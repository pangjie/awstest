"use client";

import { ChangeEvent, FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithTimeout } from "@/lib/client-fetch";
import { downloadWorkbook, downloadWorksheet, readFirstWorksheet, readNamedWorksheet } from "@/lib/excel-workbook";
import { findLocationMatches } from "@/lib/location-search";
import { LOCATION_IMPORT_HEADERS, normalizeLocationImportRow, validateLocationImportHeaders, validateUniqueLocationImportRows } from "@/lib/location-import";
import { ALL_PAGE_KEYS, canAccessAnyPage, effectivePagePermissions, isTimekeepingPageKey, NAVIGATION_DEFINITIONS, PAGE_DEFINITIONS, WAREHOUSE_DATA_TABS, type PageKey, type PageLabel, type TimekeepingPageKey, type WarehouseDataTabKey } from "@/lib/page-permissions";
import { normalizeReserveInventoryRow, RESERVE_INVENTORY_HEADERS, RESERVE_INVENTORY_SHEET, validateReserveInventoryHeaders, validateReserveInventoryRows } from "@/lib/reserve-inventory-excel";
import { buildReserveSkuStatistics } from "@/lib/reserve-statistics";
import { normalizeSkuCatalogRow, validateSkuCatalogHeaders } from "@/lib/sku-catalog";
import { printWarehouseTaskSheet } from "@/lib/task-sheet-pdf";
import { normalizeWarehouseLedgerRow, validateWarehouseLedgerHeaders, validateWarehouseLedgerRows, WAREHOUSE_LEDGER_HEADERS, WAREHOUSE_LEDGER_HISTORY_SHEET } from "@/lib/warehouse-ledger-excel";
import { formatWarehouseDateTimeFixed, formatWarehouseTime, parseStoredTimestamp, previousWarehouseDateKey, toWarehouseDateTimeInput, warehouseDateKey, warehouseDateTimeInputToIso } from "@/lib/warehouse-time";
import { addDays } from "@/lib/timekeeping/time";
import BrandMark from "./brand-mark";
import { currentDate } from "./timekeeping/format";
import TimekeepingModule from "./timekeeping/timekeeping-module";
import type { DashboardFilters, EmployeeSortState } from "./timekeeping/types";

type Role="admin"|"manager"|"operator";
type SessionUser={id:number;username:string;name:string;role:Role;pagePermissions:PageKey[]};
type User=SessionUser&{email:string;active:boolean};
type Pallet={id:string;skuId:number;sku:string;remarks:string;locationId:number|null;location:string|null;status:"in_stock"|"in_task";inboundAt:string;ageDays:number};
type Task={id:string;type:"store"|"pick"|"move";status:"pending"|"claimed"|"completed"|"returned"|"partial"|"cancelled";priority:"normal"|"urgent";dueAt:string|null;note:string|null;createdAt:string;completedAt?:string|null;palletId:string|null;sku:string|null;palletRemarks:string|null;plannedQuantity:number|null;actualQuantity:number|null;returnedQuantity:number;itemNote:string|null;itemOutcome:"completed"|"returned"|"partial"|null;itemResolvedAt:string|null;fromLocation:string|null;fromLocationType:"reserve"|"pick"|null;toLocation:string|null;toLocationType:"reserve"|"pick"|null};
type Location={id:number;code:string;type:"reserve"|"pick";zone:string;capacity:number;status:"available"|"occupied";palletCount:number};
type Movement={id:number;sourceId?:number|null;palletId:string;sku:string;remarks:string|null;taskId:string|null;operator:string|null;operatorUsername?:string|null;action:"inbound"|"pick"|"partial_pick"|"move"|"return"|"adjust";quantity:number;occurredAt:string;fromLocation:string|null;fromLocationType:"reserve"|"pick"|null;toLocation:string|null;toLocationType:"reserve"|"pick"|null};
type Stats={pallets:number;occupied:number;reserveLocations:number;reserveCapacity:number;pendingTasks:number;completedToday:number};
type AppData={currentUser:SessionUser;pallets:Pallet[];tasks:Task[];locations:Location[];movements:Movement[];users:User[];invalidSkuCodes:string[];stats:Stats;revision:number};
type SkuCatalogRecord={id:number;sku:string;barcode:string;client:string;productName:string;declaredChineseName:string;sourceRow:number;importedAt:string};
type SkuCatalogMeta={page:number;pageSize:number;total:number;uniqueCodes:number;activeRows:number;lastImportedAt:string|null};
type Modal="store"|"pick"|"move"|"accounts"|"task"|null;
type ReserveRow={location:Location;pallet:Pallet|null;slotIndex:number};
type SortKey="location"|"sku"|"inboundAt"|"ageDays"|"status";
type LedgerTab="sku"|"location"|"history";
type ApiRequest=(url:string,options?:RequestInit)=>Promise<unknown>;
type TaskGroup={task:Task;rows:Task[]};

const typeLabel={store:"存备货",pick:"取备货",move:"迁移备货"};
const actionLabel={inbound:"存备货",pick:"全部取出",partial_pick:"部分取出",move:"备货区迁移",return:"退回备货区",adjust:"手动调整"};
const taskStatusLabel={pending:"待领取",claimed:"进行中",completed:"已完成",returned:"已退回",partial:"部分完成",cancelled:"已取消"};

let sessionRecovery:Promise<never>|null=null;

function recoverExpiredSession():Promise<never> {
  if(!sessionRecovery) {
    sessionRecovery=(async()=>{
      // Never let a stalled cleanup request trap the UI on its loading screen.
      void fetch("/api/auth/logout",{method:"POST",cache:"no-store",keepalive:true}).catch(()=>{});
      window.location.replace("/?session=expired");
      return await new Promise<never>(()=>{});
    })();
  }
  return sessionRecovery;
}

async function fetchWarehouseData():Promise<AppData> {
  const response=await fetchWithTimeout("/api/v1/bootstrap",{cache:"no-store"});
  if(response.status===401) return recoverExpiredSession();
  const body=await response.json().catch(()=>({})) as {data?:AppData;error?:{message?:string}};
  if(!response.ok||!body.data) throw new Error(body.error?.message??"数据加载失败");
  return {
    ...body.data,
    movements:sortMovementsNewestFirst(body.data.movements),
    tasks:[...body.data.tasks].sort((a,b)=>parseStoredTimestamp(b.createdAt).getTime()-parseStoredTimestamp(a.createdAt).getTime()),
  };
}

async function fetchWarehouseRevision() {
  const response=await fetchWithTimeout("/api/v1/revision",{cache:"no-store"});
  if(response.status===401) return recoverExpiredSession();
  const body=await readJsonResponse<{data?:{revision:number};error?:{message?:string}}>(response);
  if(!response.ok||!body.data)throw new Error(body.error?.message??"同步状态读取失败");
  return Number(body.data.revision??0);
}

async function fetchAllMovementHistory():Promise<Movement[]> {
  const rows:Movement[]=[];
  let offset=0;
  while(true) {
    const response=await fetchWithTimeout(`/api/v1/movements?limit=1000&offset=${offset}`,{cache:"no-store"});
    if(response.status===401) return recoverExpiredSession();
    const body=await readJsonResponse<{data?:Movement[];meta?:{nextOffset:number|null};error?:{message?:string}}>(response);
    if(!response.ok||!body.data)throw new Error(body.error?.message??"操作历史加载失败");
    rows.push(...body.data);
    if(body.meta?.nextOffset===null||body.meta?.nextOffset===undefined)break;
    offset=body.meta.nextOffset;
  }
  return sortMovementsNewestFirst(rows);
}

async function fetchAllTaskDetails():Promise<Task[]> {
  const response=await fetchWithTimeout("/api/v1/tasks?detail=1",{cache:"no-store"});
  if(response.status===401) return recoverExpiredSession();
  const body=await readJsonResponse<{data?:Task[];error?:{message?:string}}>(response);
  if(!response.ok||!body.data)throw new Error(body.error?.message??"任务历史加载失败");
  return [...body.data].sort((a,b)=>parseStoredTimestamp(b.createdAt).getTime()-parseStoredTimestamp(a.createdAt).getTime());
}

async function fetchPickLocations():Promise<Location[]> {
  const response=await fetchWithTimeout("/api/v1/locations?type=pick&compact=1",{cache:"no-store"});
  if(response.status===401) return recoverExpiredSession();
  const body=await readJsonResponse<{data?:Location[];error?:{message?:string}}>(response);
  if(!response.ok||!body.data)throw new Error(body.error?.message??"拣货库位加载失败");
  return body.data;
}

async function requestApi(url:string,options?:RequestInit) {
  const response=await fetch(url,{...options,headers:{"content-type":"application/json",...(options?.headers||{})}});
  if(response.status===401) return recoverExpiredSession();
  const body=await response.json().catch(()=>({})) as {error?:{message?:string}};
  if(!response.ok) throw new Error(body.error?.message??"操作失败");
  return body;
}

async function postSkuCatalogImport<T>(payload:unknown):Promise<T> {
  const response=await fetch("/api/v1/sku-catalog",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  if(response.status===401) return recoverExpiredSession();
  const body=await readJsonResponse<{data?:T;error?:{message?:string}}>(response);
  if(!response.ok||!body.data)throw new Error(body.error?.message??"SKU 数据导入失败");
  return body.data;
}

async function postSkuCatalogCreate(payload:unknown):Promise<SkuCatalogRecord> {
  const response=await fetch("/api/v1/sku-catalog",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  if(response.status===401) return recoverExpiredSession();
  const body=await readJsonResponse<{data?:SkuCatalogRecord;error?:{message?:string}}>(response);
  if(!response.ok||!body.data)throw new Error(body.error?.message??"SKU 添加失败");
  return body.data;
}

async function readJsonResponse<T>(response:Response):Promise<T> {
  const text=await response.text();
  if(!text)throw new Error(response.ok?"服务器返回了空数据":`服务器暂时无法处理请求（${response.status}）`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok?"服务器返回了无法识别的数据":`服务器暂时无法处理请求（${response.status}）`);
  }
}

function groupTasks(tasks:Task[]):TaskGroup[] {
  const groups:TaskGroup[]=[];
  const byId=new Map<string,TaskGroup>();
  for(const row of tasks) {
    const existing=byId.get(row.id);
    if(existing){existing.rows.push(row);continue}
    const group={task:row,rows:[row]};
    byId.set(row.id,group);
    groups.push(group);
  }
  return groups;
}

function authorizedPageLabel(user:SessionUser,current:PageLabel):PageLabel {
  return NAVIGATION_DEFINITIONS.some(page=>page.label===current&&canAccessAnyPage(user,page.pagePermissions))
    ?current:NAVIGATION_DEFINITIONS.find(page=>canAccessAnyPage(user,page.pagePermissions))?.label??"备货操作";
}

function authorizedWarehouseDataTab(user:SessionUser,current:WarehouseDataTabKey):WarehouseDataTabKey {
  return WAREHOUSE_DATA_TABS.some(tab=>tab.key===current&&canAccessAnyPage(user,[tab.key]))
    ?current:WAREHOUSE_DATA_TABS.find(tab=>canAccessAnyPage(user,[tab.key]))?.key??"tasks";
}

function SidebarDateTime() {
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{
    const interval=window.setInterval(()=>setNow(new Date()),1000);
    return ()=>window.clearInterval(interval);
  },[]);
  const fullDate=formatWarehouseTime(now,{year:"numeric",month:"long",day:"numeric",weekday:"long"});
  return <div className="sidebar-date" aria-label={`${fullDate}，${formatWarehouseTime(now,{hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"})}，美东时间`}>
    <time className="sidebar-calendar" dateTime={dateKey(now.toISOString())}>
      <span suppressHydrationWarning>{formatWarehouseTime(now,{year:"numeric"})} · {formatWarehouseTime(now,{weekday:"long"})}</span>
      <strong suppressHydrationWarning>{formatWarehouseTime(now,{month:"long",day:"numeric"})}</strong>
    </time>
    <time className="sidebar-clock" dateTime={now.toISOString()}>
      <strong suppressHydrationWarning>{formatWarehouseTime(now,{hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"})}</strong>
      <span>美东时间</span>
    </time>
  </div>;
}

export default function WarehouseApp({user}:{user:SessionUser}) {
  const [active,setActive]=useState<PageLabel>(()=>NAVIGATION_DEFINITIONS.find(page=>canAccessAnyPage(user,page.pagePermissions))?.label??"备货操作");
  const [warehouseDataTab,setWarehouseDataTab]=useState<WarehouseDataTabKey>(()=>authorizedWarehouseDataTab(user,"tasks"));
  const [warehouseDataVisited,setWarehouseDataVisited]=useState(()=>authorizedPageLabel(user,"备货操作")==="备货数据");
  const [data,setData]=useState<AppData|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [ledgerEntry,setLedgerEntry]=useState<{tab:LedgerTab;query:string}>({tab:"sku",query:""});
  const [selected,setSelected]=useState<string[]>([]);
  const [modal,setModal]=useState<Modal>(null);
  const [currentTask,setCurrentTask]=useState<Task|null>(null);
  const [editingRow,setEditingRow]=useState<ReserveRow|null>(null);
  const [toast,setToast]=useState("");
  const [externalSyncKey,setExternalSyncKey]=useState(0);
  const [timeScanBadge,setTimeScanBadge]=useState("");
  const [timeRecordBadge,setTimeRecordBadge]=useState("");
  const [timeDashboardDate,setTimeDashboardDate]=useState(currentDate);
  const [timeDashboardExportStartDate,setTimeDashboardExportStartDate]=useState(currentDate);
  const [timeDashboardExportEndDate,setTimeDashboardExportEndDate]=useState(currentDate);
  const [timeDashboardFilters,setTimeDashboardFilters]=useState<DashboardFilters>({channel:[],type:[],state:[],employee:[]});
  const [timeEmployeeSort,setTimeEmployeeSort]=useState<EmployeeSortState>({key:"name",descending:false});
  const [timeDashboardExportKey,setTimeDashboardExportKey]=useState(0);
  const [timeDashboardImportOpen,setTimeDashboardImportOpen]=useState(false);
  const [timekeepingTitleTarget,setTimekeepingTitleTarget]=useState<HTMLDivElement|null>(null);
  const [ledgerMovements,setLedgerMovements]=useState<Movement[]|null>(null);
  const [taskHistory,setTaskHistory]=useState<Task[]|null>(null);
  const [pickLocations,setPickLocations]=useState<Location[]|null>(null);
  const [ledgerLoading,setLedgerLoading]=useState(false);
  const [pickLocationsLoading,setPickLocationsLoading]=useState(false);
  const [ledgerError,setLedgerError]=useState("");
  const [taskHistoryError,setTaskHistoryError]=useState("");
  const [pickLocationsError,setPickLocationsError]=useState("");
  const revisionRef=useRef<number|null>(null);
  const syncInFlightRef=useRef(false);
  const loadedRevision=data?.revision;
  const effectiveUser=data?.currentUser??user;
  const visiblePages=useMemo(
    ()=>NAVIGATION_DEFINITIONS.filter(page=>canAccessAnyPage(effectiveUser,page.pagePermissions)),
    [effectiveUser],
  );
  const allowedPageKeys=useMemo(()=>new Set(effectivePagePermissions(effectiveUser.role,effectiveUser.pagePermissions)),[effectiveUser]);
  const visibleWarehouseDataTabs=useMemo(
    ()=>WAREHOUSE_DATA_TABS.filter(tab=>allowedPageKeys.has(tab.key)),
    [allowedPageKeys],
  );
  const warehouseDataMounted=warehouseDataVisited||active==="备货数据";
  const activeNavigation=visiblePages.find(page=>page.label===active);
  const activeTimekeepingPage:TimekeepingPageKey|null=activeNavigation&&isTimekeepingPageKey(activeNavigation.key)?activeNavigation.key:null;

  const refresh=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const nextData=await fetchWarehouseData();
      setData(nextData);
      setActive(current=>authorizedPageLabel(nextData.currentUser,current));
      setWarehouseDataTab(current=>authorizedWarehouseDataTab(nextData.currentUser,current));
      revisionRef.current=nextData.revision;
      setLedgerMovements(null);setTaskHistory(null);setPickLocations(null);setLedgerError("");setTaskHistoryError("");setPickLocationsError("");
    }
    catch(loadError){setError(loadError instanceof Error?loadError.message:"数据加载失败")}
    finally{setLoading(false)}
  },[]);
  useEffect(()=>{
    let cancelled=false;
    void fetchWarehouseData()
      .then(nextData=>{if(!cancelled){revisionRef.current=nextData.revision;setData(nextData);setActive(current=>authorizedPageLabel(nextData.currentUser,current));setWarehouseDataTab(current=>authorizedWarehouseDataTab(nextData.currentUser,current));setLoading(false)}})
      .catch(loadError=>{if(!cancelled){setError(loadError instanceof Error?loadError.message:"数据加载失败");setLoading(false)}});
    return ()=>{cancelled=true};
  },[]);
  const syncIfChanged=useCallback(async()=>{
    if(document.visibilityState!=="visible"||!navigator.onLine||syncInFlightRef.current)return;
    syncInFlightRef.current=true;
    try {
      const revision=await fetchWarehouseRevision();
      if(revisionRef.current===null){revisionRef.current=revision;return}
      if(revision===revisionRef.current)return;
      const nextData=await fetchWarehouseData();
      revisionRef.current=nextData.revision;
      setData(nextData);setActive(current=>authorizedPageLabel(nextData.currentUser,current));setWarehouseDataTab(current=>authorizedWarehouseDataTab(nextData.currentUser,current));setLedgerMovements(null);setTaskHistory(null);setPickLocations(null);setLedgerError("");setTaskHistoryError("");setPickLocationsError("");setExternalSyncKey(value=>value+1);setError("");
      setToast("已同步其他设备的最新操作");
      window.setTimeout(()=>setToast(current=>current==="已同步其他设备的最新操作"?"":current),2600);
    } catch {
      // Keep the current screen usable; the next interval/focus event retries automatically.
    } finally {
      syncInFlightRef.current=false;
    }
  },[]);
  useEffect(()=>{
    const interval=window.setInterval(()=>void syncIfChanged(),10000);
    const onFocus=()=>void syncIfChanged();
    const onVisibility=()=>{if(document.visibilityState==="visible")void syncIfChanged()};
    window.addEventListener("focus",onFocus);
    window.addEventListener("online",onFocus);
    document.addEventListener("visibilitychange",onVisibility);
    return ()=>{
      window.clearInterval(interval);
      window.removeEventListener("focus",onFocus);
      window.removeEventListener("online",onFocus);
      document.removeEventListener("visibilitychange",onVisibility);
    };
  },[syncIfChanged]);
  useEffect(()=>{
    if(!warehouseDataMounted||!allowedPageKeys.has("warehouse-ledger")||loadedRevision===undefined||ledgerMovements)return;
    let cancelled=false;
    const loadingTimer=window.setTimeout(()=>{if(!cancelled){setLedgerLoading(true);setLedgerError("")}},0);
    void fetchAllMovementHistory()
      .then(rows=>{if(!cancelled)setLedgerMovements(rows)})
      .catch(loadError=>{if(!cancelled)setLedgerError(loadError instanceof Error?loadError.message:"操作历史加载失败")})
      .finally(()=>{window.clearTimeout(loadingTimer);if(!cancelled)setLedgerLoading(false)});
    return ()=>{cancelled=true;window.clearTimeout(loadingTimer)};
  },[warehouseDataMounted,allowedPageKeys,loadedRevision,ledgerMovements]);
  useEffect(()=>{
    const needsPickLocations=modal==="pick"||(warehouseDataMounted&&(allowedPageKeys.has("location-management")||allowedPageKeys.has("warehouse-ledger")));
    if(!needsPickLocations||loadedRevision===undefined||pickLocations)return;
    let cancelled=false;
    const loadingTimer=window.setTimeout(()=>{if(!cancelled){setPickLocationsLoading(true);setPickLocationsError("")}},0);
    void fetchPickLocations()
      .then(rows=>{if(!cancelled)setPickLocations(rows)})
      .catch(loadError=>{if(!cancelled)setPickLocationsError(loadError instanceof Error?loadError.message:"拣货库位加载失败")})
      .finally(()=>{window.clearTimeout(loadingTimer);if(!cancelled)setPickLocationsLoading(false)});
    return ()=>{cancelled=true;window.clearTimeout(loadingTimer)};
  },[warehouseDataMounted,allowedPageKeys,modal,loadedRevision,pickLocations]);
  useEffect(()=>{
    if(!warehouseDataMounted||!allowedPageKeys.has("tasks")||loadedRevision===undefined||taskHistory)return;
    let cancelled=false;
    void fetchAllTaskDetails()
      .then(rows=>{if(!cancelled){setTaskHistory(rows);setTaskHistoryError("")}})
      .catch(loadError=>{if(!cancelled)setTaskHistoryError(loadError instanceof Error?loadError.message:"任务历史加载失败")})
    return ()=>{cancelled=true};
  },[warehouseDataMounted,allowedPageKeys,loadedRevision,taskHistory]);
  useEffect(()=>{window.scrollTo({top:0,left:0,behavior:"auto"})},[active,warehouseDataTab]);
  useEffect(()=>{
    const media=window.matchMedia("(max-width: 760px)");
    const leaveHiddenPage=()=>{
      const currentPage=visiblePages.find(page=>page.label===active);
      if(media.matches&&currentPage?.narrowHidden){
        const destination=visiblePages.find(page=>!page.narrowHidden)??visiblePages[0];
        if(destination)setActive(destination.label);
        setSelected([]);setEditingRow(null);
      }
    };
    leaveHiddenPage();
    media.addEventListener("change",leaveHiddenPage);
    return ()=>media.removeEventListener("change",leaveHiddenPage);
  },[active,visiblePages]);

  const notify=(text:string)=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};
  const openTask=(task:Task)=>{setCurrentTask(task);setModal("task")};
  const openFlow=(name:"store"|"pick"|"move",palletIds?:string[])=>{
    const flowSelection=palletIds??selected;
    if(name!=="store"&&!flowSelection.length&&active==="备库总表"){notify("请先选择至少一个可操作托盘");return}
    if(palletIds) setSelected(flowSelection);
    setModal(name);
  };

  const pendingTaskGroups=useMemo(()=>groupTasks(data?.tasks??[]),[data]);
  const allTaskGroups=useMemo(()=>groupTasks(taskHistory??data?.tasks??[]),[taskHistory,data]);
  const invalidSkuCodes=useMemo(()=>new Set(data?.invalidSkuCodes??[]),[data]);
  const allLocations=useMemo(()=>[...(data?.locations??[]),...(pickLocations??[])],[data,pickLocations]);

  if(loading&&!data) return <div className="app-loading" aria-label="正在读取仓库数据"><BrandMark className="brand-mark"/></div>;
  if(error&&!data) return <div className="app-loading error-state"><b>数据加载失败</b><p>{error}</p><button onClick={()=>refresh()}>重新加载</button></div>;
  const stats=data!.stats;
  const currentTaskRows=currentTask?(taskHistory??data!.tasks).filter(task=>task.id===currentTask.id):[];
  const latestCurrentTask=currentTaskRows[0]??currentTask;

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand"><BrandMark className="brand-mark"/><div><strong>内库</strong><span>WAREHOUSE</span></div></div>
        <SidebarDateTime/>
      </div>
      <nav>{visiblePages.map((page,index)=><Fragment key={page.key}>{(index===0||visiblePages[index-1].group!==page.group)&&<span className="nav-group-label">{page.group==="warehouse"?"备货体系":"工时体系"}</span>}<button data-nav={page.label} aria-label={page.label} title={page.label} className={active===page.label?"nav-item active":"nav-item"} onClick={()=>{setActive(page.label);setTimeDashboardImportOpen(false);if(page.key==="time-scan")setTimeScanBadge("");if(page.label==="备货数据")setWarehouseDataVisited(true);setSelected([]);setEditingRow(null)}}>
        <span className="nav-icon">{page.icon}</span>{page.label}{page.key==="warehouse-data"&&allowedPageKeys.has("tasks")&&stats.pendingTasks>0&&<b className="nav-badge">{stats.pendingTasks}</b>}
      </button></Fragment>)}</nav>
      <div className="sidebar-bottom">
        {effectiveUser.role==="admin"&&<button className="nav-item" onClick={()=>setModal("accounts")}><span className="nav-icon">⚙</span>账户管理<span className="admin-tag">ADMIN</span></button>}
        <div className="user"><div className="avatar">{effectiveUser.name.slice(0,1)}</div><div><strong>{effectiveUser.name}</strong><span>{roleName(effectiveUser.role)}</span></div>
          <button aria-label="退出登录" title="退出登录" onClick={async()=>{await fetch("/api/auth/logout",{method:"POST"});location.reload()}}>↪</button></div>
      </div>
    </aside>
    <section className="workspace" data-page={active}>
      {active!=="备货操作"&&<header><div className="workspace-title"><h1>{active}</h1></div><div className="workspace-title-tools" ref={setTimekeepingTitleTarget}>{activeTimekeepingPage==="time-dashboard"&&<div className="time-dashboard-title-actions"><button className="primary" type="button" onClick={()=>setTimeDashboardImportOpen(true)}>导入波次</button><button className="time-dashboard-current" type="button" onClick={()=>setTimeDashboardDate(currentDate())}>当前波次</button><button className="time-dashboard-day" type="button" onClick={()=>setTimeDashboardDate(date=>addDays(date,-1))}>前一天</button><button className="time-dashboard-day" type="button" onClick={()=>setTimeDashboardDate(date=>addDays(date,1))}>后一天</button><div className="time-dashboard-date-range" role="group" aria-label="导出日期范围"><label className="time-dashboard-date"><span title="仅用于导出">起始日期</span><input aria-label="导出起始日期" title="仅用于导出" type="date" value={timeDashboardExportStartDate} max={timeDashboardExportEndDate} onChange={event=>{const value=event.target.value;if(!value)return;setTimeDashboardExportStartDate(value);if(value>timeDashboardExportEndDate)setTimeDashboardExportEndDate(value)}}/></label><label className="time-dashboard-date"><span title="仅用于导出">终止日期</span><input aria-label="导出终止日期" title="仅用于导出" type="date" value={timeDashboardExportEndDate} min={timeDashboardExportStartDate} onChange={event=>{const value=event.target.value;if(!value)return;setTimeDashboardExportEndDate(value);if(value<timeDashboardExportStartDate)setTimeDashboardExportStartDate(value)}}/></label></div><button className="time-dashboard-export" type="button" onClick={()=>setTimeDashboardExportKey(key=>key+1)}>导出</button></div>}</div></header>}
      <div className="content">
        {active==="备货操作"&&<Dashboard stats={stats} tasks={pendingTaskGroups} onFlow={setModal} onTask={openTask} openTasks={()=>{setWarehouseDataTab("tasks");setWarehouseDataVisited(true);setActive("备货数据")}} data={data!} invalidSkuCodes={invalidSkuCodes} canOpenTasks={allowedPageKeys.has("tasks")} canOpenLedger={allowedPageKeys.has("warehouse-ledger")} openHistory={()=>{setLedgerEntry({tab:"history",query:""});setWarehouseDataTab("warehouse-ledger");setWarehouseDataVisited(true);setActive("备货数据")}}/>}
        {active==="备库总表"&&<ReserveTable pallets={data!.pallets} locations={data!.locations} selected={selected} setSelected={setSelected} onFlow={openFlow} notify={notify} done={async message=>{notify(message);await refresh()}} onEdit={setEditingRow} onLocation={allowedPageKeys.has("warehouse-ledger")?code=>{setLedgerEntry({tab:"location",query:code});setWarehouseDataTab("warehouse-ledger");setWarehouseDataVisited(true);setActive("备货数据")}:undefined} invalidSkuCodes={invalidSkuCodes}/>}
        {warehouseDataMounted&&<div className="warehouse-data-page" hidden={active!=="备货数据"}>
          <div className="warehouse-data-tabs" role="tablist" aria-label="备货数据">
            {visibleWarehouseDataTabs.map(tab=><button key={tab.key} type="button" role="tab" aria-selected={warehouseDataTab===tab.key} className={warehouseDataTab===tab.key?"active":""} onClick={()=>{setWarehouseDataTab(tab.key);if(tab.key==="warehouse-ledger")setLedgerEntry({tab:"sku",query:""})}}><span aria-hidden="true">{tab.icon}</span>{tab.label}</button>)}
          </div>
          {allowedPageKeys.has("tasks")&&<div className="warehouse-data-panel" role="tabpanel" hidden={warehouseDataTab!=="tasks"}><TasksView tasks={allTaskGroups} onTask={openTask} invalidSkuCodes={invalidSkuCodes} error={taskHistoryError}/></div>}
          {allowedPageKeys.has("sku-management")&&<div className="warehouse-data-panel" role="tabpanel" hidden={warehouseDataTab!=="sku-management"}><SkuManagement externalRefreshKey={externalSyncKey} onImported={async message=>{notify(message);await refresh()}}/></div>}
          {allowedPageKeys.has("location-management")&&<div className="warehouse-data-panel" role="tabpanel" hidden={warehouseDataTab!=="location-management"}><LocationManagement locations={allLocations} api={requestApi} done={async message=>{notify(message);await refresh()}} loading={pickLocationsLoading} externalError={pickLocationsError}/></div>}
          {allowedPageKeys.has("warehouse-ledger")&&<div className="warehouse-data-panel" role="tabpanel" hidden={warehouseDataTab!=="warehouse-ledger"}><WarehouseLedger key={`${ledgerEntry.tab}:${ledgerEntry.query}`} pallets={data!.pallets} locations={allLocations} movements={ledgerMovements??[]} initialTab={ledgerEntry.tab} initialQuery={ledgerEntry.query} invalidSkuCodes={invalidSkuCodes} loading={ledgerLoading||pickLocationsLoading} error={ledgerError||pickLocationsError} api={requestApi} done={async message=>{notify(message);await refresh()}}/></div>}
        </div>}
        {activeTimekeepingPage&&<TimekeepingModule
          page={activeTimekeepingPage} titleTarget={timekeepingTitleTarget} isAdmin={effectiveUser.role==="admin"}
          initialScanBadge={timeScanBadge} initialRecordBadge={timeRecordBadge}
          openScan={allowedPageKeys.has("time-scan")?badge=>{setTimeScanBadge(badge);setActive("扫描台")}:undefined}
          openRecords={allowedPageKeys.has("time-records")?badge=>{setTimeRecordBadge(badge);setActive("工作记录")}:undefined}
          dashboardDate={timeDashboardDate} dashboardExportStartDate={timeDashboardExportStartDate} dashboardExportEndDate={timeDashboardExportEndDate}
          dashboardFilters={timeDashboardFilters} setDashboardFilters={setTimeDashboardFilters} dashboardExportKey={timeDashboardExportKey}
          dashboardImportOpen={timeDashboardImportOpen} closeDashboardImport={()=>setTimeDashboardImportOpen(false)}
          employeeSort={timeEmployeeSort} setEmployeeSort={setTimeEmployeeSort}/>}
      </div>
    </section>
    {modal&&["store","pick","move"].includes(modal)&&<TaskCreateModal type={modal as "store"|"pick"|"move"} pallets={data!.pallets} locations={modal==="pick"?allLocations:data!.locations} selected={selected} close={()=>setModal(null)} locationsLoading={modal==="pick"&&pickLocationsLoading} locationsError={modal==="pick"?pickLocationsError:""}
      done={async(message)=>{setModal(null);setSelected([]);notify(message);await refresh()}} api={requestApi}/>}
    {modal==="task"&&latestCurrentTask&&<TaskModal task={latestCurrentTask} rows={currentTaskRows} close={()=>setModal(null)} api={requestApi} invalidSkuCodes={invalidSkuCodes}
      done={async message=>{setModal(null);notify(message);await refresh()}}
      updated={async message=>{notify(message);await refresh()}}/>}
    {modal==="accounts"&&effectiveUser.role==="admin"&&<AccountsModal users={data!.users} currentUserId={effectiveUser.id} close={()=>setModal(null)} api={requestApi} done={async m=>{notify(m);await refresh()}}/>}
    {editingRow&&<InventoryEditModal row={editingRow} locations={data!.locations} close={()=>setEditingRow(null)} api={requestApi} done={async message=>{setEditingRow(null);notify(message);await refresh()}}/>}
    {toast&&<div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}

function Dashboard({stats,tasks,onFlow,onTask,openTasks,data,openHistory,invalidSkuCodes,canOpenTasks,canOpenLedger}:{stats:Stats;tasks:TaskGroup[];onFlow:(m:Modal)=>void;onTask:(t:Task)=>void;openTasks:()=>void;data:AppData;openHistory:()=>void;invalidSkuCodes:Set<string>;canOpenTasks:boolean;canOpenLedger:boolean}) {
  const occupancy=stats.reserveCapacity?Math.round(stats.occupied/stats.reserveCapacity*100):0;
  const now=new Date();
  const recentDateKeys=new Set([warehouseDateKey(now),previousWarehouseDateKey(now)]);
  const recentMovements=data.movements.filter(movement=>recentDateKeys.has(warehouseDateKey(movement.occurredAt)));
  return <><div className="quick-actions dashboard-quick-actions" aria-label="备货核心操作"><button className="core-action store-action" onClick={()=>onFlow("store")}><span className="qa green">↓</span><b>存备货</b><small>批量入库</small></button><button className="core-action pick-action" onClick={()=>onFlow("pick")}><span className="qa blue">↗</span><b>取备货</b><small>供给拣货位</small></button><button className="core-action move-action" onClick={()=>onFlow("move")}><span className="qa amber">↔</span><b>迁移备货</b><small>库内移位</small></button></div>
    <div className="dashboard-overview-grid"><div className="metric-grid dashboard-metric-grid"><Metric label="备货库存" value={String(stats.pallets)} unit="托" note="当前有效托盘" color="blue"/><Metric label="托盘位占用" value={String(occupancy)} unit="%" note={`${stats.occupied} / ${stats.reserveCapacity} 托盘位`} color="green"/><Metric label="今日已处理托盘" value={String(stats.completedToday)} unit="托" note="今日已确认作业结果" color="violet"/></div>
      <section className="panel tasks-panel"><div className="panel-title"><div><h3>待办任务</h3><p>{tasks.length} 个待处理任务</p></div>{canOpenTasks&&<button onClick={openTasks}>查看全部 →</button>}</div><div className="task-list">{tasks.length?tasks.map(group=><TaskRow key={group.task.id} task={group.task} rows={group.rows} onClick={()=>onTask(group.task)} invalidSkuCodes={invalidSkuCodes}/>):<Empty text="当前没有待办任务"/>}</div></section></div>
    <section className="panel dashboard-history"><div className="panel-title"><div><h3>最近操作历史</h3><p>包含今日及前一天的全部操作记录，共 {recentMovements.length} 条</p></div>{canOpenLedger&&<button onClick={openHistory}>查看全部 →</button>}</div><LedgerMovementTable rows={recentMovements} invalidSkuCodes={invalidSkuCodes}/></section>
  </>;
}

function Metric({label,value,unit,note,color}:{label:string;value:string;unit:string;note:string;color:string}) {
  return <article className="metric"><div className={`metric-icon ${color}`}>{color==="blue"?"▦":color==="green"?"◎":"✓"}</div><div className="metric-copy"><p>{label}</p><h3><strong>{value}</strong><span>{unit}</span></h3><small>{note}</small></div></article>;
}

function ReserveTable({pallets,locations,selected,setSelected,onFlow,notify,done,onLocation,onEdit,invalidSkuCodes}:{pallets:Pallet[];locations:Location[];selected:string[];setSelected:(v:string[])=>void;onFlow:(v:"pick"|"move",palletIds?:string[])=>void;notify:(v:string)=>void;done:(message:string)=>void|Promise<void>;onLocation?:((v:string)=>void);onEdit:(row:ReserveRow)=>void;invalidSkuCodes:Set<string>}) {
  const [skuQuery,setSkuQuery]=useState("");
  const [exactSkuQuery,setExactSkuQuery]=useState("");
  const [locationQuery,setLocationQuery]=useState("");
  const [inboundFrom,setInboundFrom]=useState("");
  const [inboundTo,setInboundTo]=useState("");
  const [status,setStatus]=useState("all");
  const [sortKey,setSortKey]=useState<SortKey>("location");
  const [sortDirection,setSortDirection]=useState<"asc"|"desc">("asc");
  const [importing,setImporting]=useState(false);
  const [importError,setImportError]=useState("");
  useEffect(()=>{
    const media=window.matchMedia("(max-width: 760px)");
    const resetNarrowFilters=()=>{
      if(!media.matches)return;
      setSkuQuery("");setExactSkuQuery("");setLocationQuery("");setInboundFrom("");setInboundTo("");setStatus("all");setSelected([]);
    };
    resetNarrowFilters();
    media.addEventListener("change",resetNarrowFilters);
    return ()=>media.removeEventListener("change",resetNarrowFilters);
  },[setSelected]);
  const exactSkuCodes=useMemo(()=>parseExactSkuList(exactSkuQuery),[exactSkuQuery]);
  const statistics=useMemo(()=>buildReserveSkuStatistics(pallets,locations),[pallets,locations]);
  const allRows=useMemo<ReserveRow[]>(()=>{
    const byLocation=new Map<string,Pallet[]>();
    for(const pallet of pallets) if(pallet.location) byLocation.set(pallet.location,[...(byLocation.get(pallet.location)??[]),pallet]);
    return locations.filter(location=>location.type==="reserve").flatMap(location=>{
      const stored=(byLocation.get(location.code)??[]).sort((a,b)=>a.inboundAt.localeCompare(b.inboundAt));
      const slotCount=Math.max(location.capacity||1,stored.length);
      return Array.from({length:slotCount},(_,index)=>({location,pallet:stored[index]??null,slotIndex:index+1}));
    });
  },[pallets,locations]);
  const rows=useMemo(()=>{
    const sku=skuQuery.trim().toLowerCase(),location=locationQuery.trim().toLowerCase();
    const exactMatchCount=(row:ReserveRow)=>
      Number(Boolean(location)&&row.location.code.toLowerCase()===location)
      +Number(Boolean(sku)&&row.pallet?.sku.toLowerCase()===sku);
    return allRows.filter(row=>{
      const state=reserveRowStatus(row);
      const inbound=row.pallet?dateKey(row.pallet.inboundAt):"";
      return (!sku||row.pallet?.sku.toLowerCase().includes(sku))
        &&(!exactSkuCodes.size||Boolean(row.pallet)&&exactSkuCodes.has(row.pallet!.sku.toUpperCase()))
        &&(!location||row.location.code.toLowerCase().includes(location))
        &&(!inboundFrom||Boolean(inbound)&&inbound>=inboundFrom)
        &&(!inboundTo||Boolean(inbound)&&inbound<=inboundTo)
        &&(status==="all"||state===status);
    }).sort((a,b)=>{
      const invalidPriority=Number(Boolean(b.pallet&&invalidSkuCodes.has(b.pallet.sku)))
        -Number(Boolean(a.pallet&&invalidSkuCodes.has(a.pallet.sku)));
      if(invalidPriority)return invalidPriority;
      const relevance=exactMatchCount(b)-exactMatchCount(a);
      if(relevance)return relevance;
      if(["sku","inboundAt","ageDays"].includes(sortKey)&&Boolean(a.pallet)!==Boolean(b.pallet))return a.pallet?-1:1;
      const aValue=sortValue(a,sortKey),bValue=sortValue(b,sortKey);
      const result=typeof aValue==="number"&&typeof bValue==="number"?aValue-bValue:String(aValue).localeCompare(String(bValue),"zh-CN",{numeric:true});
      return sortDirection==="asc"?result:-result;
    });
  },[allRows,skuQuery,exactSkuCodes,locationQuery,inboundFrom,inboundTo,status,sortKey,sortDirection,invalidSkuCodes]);
  const sortable=(key:SortKey,label:string)=><button className="sort-button" aria-label={`按${label}排序`} onClick={()=>{if(sortKey===key)setSortDirection(value=>value==="asc"?"desc":"asc");else{setSortKey(key);setSortDirection("asc")}}}>{label}<span aria-hidden="true">{sortKey===key?(sortDirection==="asc"?"▲":"▼"):"▲▼"}</span></button>;
  const selectable=rows.map(reserveRowSelectionKey);
  const selectedRows=rows.filter(row=>selected.includes(reserveRowSelectionKey(row)));
  const selectedPalletIds=selectedRows.flatMap(row=>row.pallet?.status==="in_stock"?[row.pallet.id]:[]);
  const clearFilters=()=>{setSkuQuery("");setExactSkuQuery("");setLocationQuery("");setInboundFrom("");setInboundTo("");setStatus("all")};
  const exportSelected=async()=>{
    setImportError("");
    try {
      await downloadReserveWorkbook(selectedRows);
      notify(`已导出选中的 ${selectedRows.length} 条记录`);
    } catch(error) {
      setImportError(error instanceof Error?error.message:"备库总表导出失败");
    }
  };
  const exportStatistics=async()=>{
    setImportError("");
    try {
      await downloadReserveStatisticsWorkbook(statistics);
      notify(`已导出 ${statistics.length} 个 SKU 的备货统计`);
    } catch(error) {
      setImportError(error instanceof Error?error.message:"备货统计导出失败");
    }
  };
  const importReserveWorkbook=async(event:ChangeEvent<HTMLInputElement>)=>{
    const input=event.currentTarget,file=input.files?.[0];
    if(!file)return;
    setImporting(true);setImportError("");
    try {
      if(!file.name.toLowerCase().endsWith(".xlsx"))throw new Error("请选择 .xlsx 格式的备库总表文件");
      const {headers,rows:sourceRows}=await readNamedWorksheet(await file.arrayBuffer(),RESERVE_INVENTORY_SHEET);
      validateReserveInventoryHeaders(headers);
      const normalized=sourceRows.flatMap((row,index)=>{
        const item=normalizeReserveInventoryRow(row,index+2);
        return item?[item]:[];
      });
      validateReserveInventoryRows(normalized);
      const response=await requestApi("/api/v1/pallets/import",{method:"POST",body:JSON.stringify({rows:normalized})}) as {data?:{importedRows:number;createdRows:number;updatedRows:number;skippedRows:number}};
      if(!response.data)throw new Error("服务器没有返回备库总表导入结果");
      await done(`备库总表导入完成：新增 ${response.data.createdRows.toLocaleString()} 托，更新 ${response.data.updatedRows.toLocaleString()} 托，未变化 ${response.data.skippedRows.toLocaleString()} 托`);
    } catch(error) {
      setImportError(error instanceof Error?error.message:"备库总表导入失败");
    } finally {
      setImporting(false);input.value="";
    }
  };
  const filterCount=[skuQuery,exactSkuQuery,locationQuery,inboundFrom,inboundTo,status==="all"?"":status].filter(Boolean).length;
  return <section className="panel inventory-panel reserve-table"><div className="panel-title inventory-title"><div><h3>备库托盘与库位总表</h3><p>共 {allRows.length} 个托盘位，当前 {allRows.filter(row=>row.pallet).length} 托在库</p></div><div className="inventory-title-actions selection-toolbar"><button className="reserve-statistics-export" disabled={!statistics.length} onClick={()=>void exportStatistics()}>⇩ 导出备货统计</button><label className={importing?"reserve-import-button busy":"reserve-import-button"}>⇧ {importing?"正在导入…":"导入备库总表"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importing} onChange={importReserveWorkbook}/></label><b className="selection-count">已选 <strong>{selectedRows.length}</strong> 条记录</b><button className="selected-export" disabled={!selectedRows.length} onClick={exportSelected}>导出已选</button><button disabled={!selectedPalletIds.length} onClick={()=>onFlow("pick",selectedPalletIds)}>批量取备货</button><button disabled={!selectedPalletIds.length} onClick={()=>onFlow("move",selectedPalletIds)}>批量迁移</button><button className="cancel-selection" disabled={!selectedRows.length} onClick={()=>setSelected([])}>取消</button></div></div>
    {importError&&<div className="reserve-import-error" role="alert">! {importError}</div>}
    <div className="reserve-filter-panel">
      <div className="reserve-filter-bar">
        <label className="filter-field search-field"><span>库位</span><div><i>⌕</i><input aria-label="搜索库位" value={locationQuery} onChange={e=>setLocationQuery(e.target.value)} placeholder="模糊搜索库位"/></div></label>
        <label className="filter-field search-field"><span>SKU</span><div><i>⌕</i><input aria-label="搜索 SKU" value={skuQuery} onChange={e=>setSkuQuery(e.target.value)} placeholder="模糊搜索 SKU"/></div></label>
        <label className="filter-field search-field exact-sku-field"><span>多个 SKU（精确）</span><div><i>≡</i><textarea rows={1} aria-label="精确搜索多个 SKU" value={exactSkuQuery} onChange={e=>setExactSkuQuery(e.target.value)} placeholder="逗号、分号或换行分隔"/></div></label>
        <label className="filter-field status-filter"><span>状态</span><select aria-label="库存状态" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">全部状态</option><option value="in_stock">在库</option><option value="in_task">作业中</option><option value="available">空托盘位</option></select></label>
        <fieldset className="filter-field date-filter"><legend>入库日期</legend><div className="date-range"><input aria-label="入库开始日期" type="date" value={inboundFrom} max={inboundTo||undefined} onInput={e=>setInboundFrom(e.currentTarget.value)}/><span>—</span><input aria-label="入库结束日期" type="date" value={inboundTo} min={inboundFrom||undefined} onInput={e=>setInboundTo(e.currentTarget.value)}/></div></fieldset>
        <button className="clear-filters" disabled={!filterCount} onClick={clearFilters}>重置</button>
      </div>
      <div className="filter-summary"><span>找到 <b>{rows.length}</b> 条记录</span>{filterCount>0&&<em>已启用 {filterCount} 项筛选{exactSkuCodes.size>0&&` · 精确 SKU ${exactSkuCodes.size} 个`}</em>}</div>
    </div>
    <div className="table-scroll">
      <table>
        <thead><tr>
          <th><div className="indexed-location table-location-header"><input type="checkbox" aria-label="全选当前筛选结果" checked={selectable.length>0&&selectable.every(id=>selected.includes(id))} onChange={e=>setSelected(e.target.checked?selectable:[])}/>{sortable("location","库位")}</div></th>
          <th>{sortable("sku","SKU")}</th>
          <th>备注说明</th>
          <th>{sortable("inboundAt","入库时间（美东）")}</th>
          <th>{sortable("ageDays","库龄")}</th>
          <th>{sortable("status","状态")}</th>
          <th className="pallet-column"><span className="visually-hidden">托盘号</span></th>
          <th className="action-column">操作</th>
        </tr></thead>
        <tbody>{rows.map(row=>{
          const pallet=row.pallet,state=reserveRowStatus(row),selectionKey=reserveRowSelectionKey(row);
          return <tr key={`${row.location.id}-${row.slotIndex}-${pallet?.id??"empty"}`} className={!pallet?"empty-location-row":""}>
            <td><div className="indexed-location"><input type="checkbox" aria-label={pallet?`选择 ${pallet.id}`:`选择空托盘位 ${row.location.code}`} checked={selected.includes(selectionKey)} onChange={e=>setSelected(e.target.checked?[...selected,selectionKey]:selected.filter(id=>id!==selectionKey))}/>{onLocation?<button className="location-link" onClick={()=>onLocation(row.location.code)}>{row.location.code}</button>:<span className="location-code">{row.location.code}</span>}{row.location.capacity>1&&<span className="slot-badge">{row.slotIndex}/{row.location.capacity}</span>}</div></td>
            <td>{pallet?<b className={invalidSkuCodes.has(pallet.sku)?"sku-code invalid-sku":"sku-code"} title={invalidSkuCodes.has(pallet.sku)?"未在 SKU 主数据中找到":undefined}>{pallet.sku}</b>:<span className="empty-cell">空托盘位</span>}</td>
            <td>{pallet?.remarks?<span className="pallet-remarks">{pallet.remarks}</span>:<span className="empty-cell">{pallet?"无备注":"—"}</span>}</td>
            <td>{pallet?formatTime(pallet.inboundAt):<span className="empty-cell">—</span>}</td>
            <td>{pallet?<span className="age">{pallet.ageDays} 天</span>:<span className="empty-cell">—</span>}</td>
            <td><span className={`status ${state==="in_task"?"working":state==="available"?"empty":""}`}><i/>{reserveStatusLabel(state)}</span></td>
            <td className="pallet-column">{pallet?<code className="pallet-code">{pallet.id}</code>:<span className="empty-cell">—</span>}</td>
            <td className="action-column"><button className="edit-record" onClick={()=>onEdit(row)}>编辑</button></td>
          </tr>;
        })}</tbody>
      </table>
      {!rows.length&&<Empty text="没有符合条件的备货库位或托盘"/>}
    </div>
  </section>;
}

function SkuManagement({onImported,externalRefreshKey}:{onImported:(message:string)=>void|Promise<void>;externalRefreshKey:number}) {
  const [rows,setRows]=useState<SkuCatalogRecord[]>([]);
  const [meta,setMeta]=useState<SkuCatalogMeta>({page:1,pageSize:100,total:0,uniqueCodes:0,activeRows:0,lastImportedAt:null});
  const [q,setQ]=useState(""),[page,setPage]=useState(1),[refreshKey,setRefreshKey]=useState(0);
  const [loading,setLoading]=useState(true),[importing,setImporting]=useState(false),[importProgress,setImportProgress]=useState(0),[error,setError]=useState("");
  const [adding,setAdding]=useState(false),[saving,setSaving]=useState(false);
  const [draft,setDraft]=useState({code:"",barcode:"",client:"",productName:"",declaredChineseName:""});
  useEffect(()=>{
    const controller=new AbortController();
    const timer=window.setTimeout(async()=>{
      setLoading(true);setError("");
      try {
        const response=await fetchWithTimeout(`/api/v1/sku-catalog?q=${encodeURIComponent(q.trim())}&page=${page}&pageSize=100`,{cache:"no-store",signal:controller.signal});
        const body=await readJsonResponse<{data?:SkuCatalogRecord[];meta?:SkuCatalogMeta;error?:{message?:string}}>(response);
        if(!response.ok||!body.data||!body.meta)throw new Error(body.error?.message??"SKU 数据读取失败");
        setRows(body.data);setMeta(body.meta);
      } catch(loadError) {
        if(!controller.signal.aborted)setError(loadError instanceof Error?loadError.message:"SKU 数据读取失败");
      } finally {
        if(!controller.signal.aborted)setLoading(false);
      }
    },q.trim()?250:0);
    return ()=>{window.clearTimeout(timer);controller.abort()};
  },[q,page,refreshKey,externalRefreshKey]);
  const totalPages=Math.max(1,Math.ceil(meta.total/meta.pageSize));
  const createSku=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();setSaving(true);setError("");
    const code=draft.code.trim().toUpperCase();
    try {
      if(!code)throw new Error("请填写 SKU");
      await postSkuCatalogCreate({action:"create",...draft,code});
      setDraft({code:"",barcode:"",client:"",productName:"",declaredChineseName:""});
      setAdding(false);setQ(code);setPage(1);setRefreshKey(value=>value+1);
      await onImported(`SKU ${code} 已添加`);
    } catch(createError) {
      setError(createError instanceof Error?createError.message:"SKU 添加失败");
    } finally {setSaving(false)}
  };
  const importWorkbook=async(event:ChangeEvent<HTMLInputElement>)=>{
    const input=event.currentTarget,file=input.files?.[0];
    if(!file)return;
    setImporting(true);setImportProgress(0);setError("");
    try {
      if(!file.name.toLowerCase().endsWith(".xlsx"))throw new Error("请选择 .xlsx 格式的 WMS_PRODUCT 文件");
      const {headers,rows:sourceRows}=await readFirstWorksheet(await file.arrayBuffer());
      validateSkuCatalogHeaders(headers);
      const normalized=sourceRows.flatMap((row,index)=>{
        const item=normalizeSkuCatalogRow(row,index+2);
        return item?[item]:[];
      });
      if(!normalized.length)throw new Error("Excel 中没有可导入的 SKU 数据");
      const started=await postSkuCatalogImport<{importKey:string;importedAt:string}>({action:"start"});
      for(let index=0;index<normalized.length;index+=1000) {
        await postSkuCatalogImport<{acceptedRows:number}>({
          action:"batch",importKey:started.importKey,importedAt:started.importedAt,rows:normalized.slice(index,index+1000),
        });
        setImportProgress(Math.min(99,Math.round(Math.min(index+1000,normalized.length)/normalized.length*100)));
      }
      const result=await postSkuCatalogImport<{importedRows:number;uniqueCodes:number;addedCodes:number;updatedCodes:number;duplicateCodes:number}>({
        action:"finish",importKey:started.importKey,importedAt:started.importedAt,
      });
      setImportProgress(100);
      setQ("");setPage(1);setRefreshKey(value=>value+1);
      const changes=[
        result.addedCodes?`已新增 ${result.addedCodes.toLocaleString()} 个 SKU`:"",
        result.updatedCodes?`已更新 ${result.updatedCodes.toLocaleString()} 个已有 SKU`:"",
        result.duplicateCodes?`${result.duplicateCodes.toLocaleString()} 条文件内重复记录已按最后一条处理`:"",
      ].filter(Boolean);
      await onImported(changes.join("；")||"SKU 数据没有变化");
    } catch(importError) {
      setError(importError instanceof Error?importError.message:"SKU 数据导入失败");
    } finally {
      setImporting(false);setImportProgress(0);input.value="";
    }
  };
  return <section className="panel sku-management">
    <div className="sku-management-head">
      <div><span>SKU MASTER DATA</span><h2>SKU管理</h2><p>WMS 产品主数据用于核对备货区 SKU；未收录的在库 SKU 会以红色显示。</p></div>
      <div className="sku-management-actions">
        <button className="sku-manual-add-button" type="button" disabled={importing||saving} onClick={()=>{setAdding(value=>!value);setError("")}}>＋ 手动添加 SKU</button>
        <label className={importing?"sku-import-button busy":"sku-import-button"}>⇧ {importing?`正在导入 ${importProgress}%`:"导入 SKU 数据"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importing||saving} onChange={importWorkbook}/></label>
      </div>
    </div>
    {adding&&<form className="sku-manual-form" onSubmit={createSku}>
      <div className="sku-manual-form-title"><div><b>手动添加 SKU</b><span>SKU 为必填项，系统会忽略大小写校验重复；其余信息可选填。</span></div></div>
      <div className="sku-manual-fields">
        <label><span>SKU <b>*</b></span><input autoFocus required value={draft.code} onChange={event=>setDraft(value=>({...value,code:event.target.value.toUpperCase()}))} placeholder="输入 SKU"/></label>
        <label><span>产品条码</span><input value={draft.barcode} onChange={event=>setDraft(value=>({...value,barcode:event.target.value}))} placeholder="选填"/></label>
        <label><span>客户</span><input value={draft.client} onChange={event=>setDraft(value=>({...value,client:event.target.value}))} placeholder="选填"/></label>
        <label><span>产品名称</span><input value={draft.productName} onChange={event=>setDraft(value=>({...value,productName:event.target.value}))} placeholder="选填"/></label>
        <label><span>申报中文名</span><input value={draft.declaredChineseName} onChange={event=>setDraft(value=>({...value,declaredChineseName:event.target.value}))} placeholder="选填"/></label>
      </div>
      <div className="sku-manual-form-actions"><button type="button" onClick={()=>{setAdding(false);setError("")}}>取消</button><button type="submit" disabled={saving}>{saving?"正在添加…":"添加 SKU"}</button></div>
    </form>}
    <div className="sku-catalog-stats">
      <p><span>有效产品记录</span><b>{meta.activeRows.toLocaleString()}</b></p>
      <p><span>唯一 SKU</span><b>{meta.uniqueCodes.toLocaleString()}</b></p>
      <p><span>同名 SKU 记录</span><b>{Math.max(0,meta.activeRows-meta.uniqueCodes).toLocaleString()}</b></p>
      <p><span>最近更新（美东）</span><b>{meta.lastImportedAt?formatLedgerTime(meta.lastImportedAt):"尚未导入"}</b></p>
    </div>
    <div className="sku-catalog-toolbar">
      <label><span>⌕</span><input aria-label="搜索 SKU 主数据" value={q} onChange={event=>{setQ(event.target.value);setPage(1)}} placeholder="搜索 SKU、产品条码、客户、产品名称或申报中文名"/></label>
      <span>找到 {meta.total.toLocaleString()} 条记录</span>
    </div>
    {error&&<div className="sku-catalog-error">! {error}</div>}
    <div className="table-scroll"><table className="sku-catalog-table">
      <thead><tr><th>SKU</th><th>产品条码</th><th>客户</th><th>产品名称</th><th>申报中文名</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}><td><b className="catalog-sku">{row.sku}</b></td><td>{row.barcode||"—"}</td><td>{row.client||"—"}</td><td>{row.productName||"—"}</td><td>{row.declaredChineseName||"—"}</td></tr>)}</tbody>
    </table>{!loading&&!rows.length&&<Empty text="没有符合条件的 SKU 主数据"/>}</div>
    <div className="sku-catalog-pagination"><span>每页 {meta.pageSize} 条 · 第 {meta.page}/{totalPages} 页</span><div><button disabled={page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}>上一页</button><button disabled={page>=totalPages||loading} onClick={()=>setPage(value=>Math.min(totalPages,value+1))}>下一页</button></div></div>
  </section>;
}

function LocationManagement({locations,api,done,loading,externalError}:{locations:Location[];api:ApiRequest;done:(m:string)=>void|Promise<void>;loading:boolean;externalError:string}) {
  const [viewType,setViewType]=useState<"reserve"|"pick">("reserve");
  const [q,setQ]=useState(""),[page,setPage]=useState(1),[adding,setAdding]=useState(false),[busy,setBusy]=useState(false),[importing,setImporting]=useState(false),[error,setError]=useState("");
  const [code,setCode]=useState(""),[zone,setZone]=useState(""),[capacity,setCapacity]=useState("1");
  const [draft,setDraft]=useState<{locationId:number;originalCode:string;originalType:"reserve"|"pick";code:string;zone:string;capacity:string}|null>(null);
  const counts={reserve:locations.filter(location=>location.type==="reserve").length,pick:locations.filter(location=>location.type==="pick").length};
  const rows=locations.filter(location=>location.type===viewType&&`${location.code} ${location.zone}`.toLowerCase().includes(q.trim().toLowerCase()));
  const pageSize=100,totalPages=Math.max(1,Math.ceil(rows.length/pageSize)),visibleRows=rows.slice((page-1)*pageSize,page*pageSize);
  const switchType=(next:"reserve"|"pick")=>{setViewType(next);setQ("");setPage(1);setAdding(false);setDraft(null);setError("")};
  const create=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{await api("/api/v1/locations",{method:"POST",body:JSON.stringify({code,zone,type:viewType,capacity:Number(capacity)})});setAdding(false);setCode("");setZone("");setCapacity("1");await done(`${locationTypeLabel(viewType)}已新增`)}catch(err){setError(err instanceof Error?err.message:"新增库位失败")}finally{setBusy(false)}};
  const save=async()=>{if(!draft)return;setBusy(true);setError("");try{await api(`/api/v1/locations/${encodeURIComponent(draft.originalCode)}?type=${draft.originalType}`,{method:"PATCH",body:JSON.stringify({code:draft.code,zone:draft.zone,type:draft.originalType,capacity:Number(draft.capacity)})});setDraft(null);await done(`${locationTypeLabel(draft.originalType)}信息已更新`)}catch(err){setError(err instanceof Error?err.message:"更新库位失败")}finally{setBusy(false)}};
  const importLocations=async(event:ChangeEvent<HTMLInputElement>)=>{
    const input=event.currentTarget,file=input.files?.[0];
    if(!file)return;
    setImporting(true);setError("");
    try {
      if(!file.name.toLowerCase().endsWith(".xlsx"))throw new Error("请选择 .xlsx 格式的库位文件");
      const {headers,rows:sourceRows}=await readFirstWorksheet(await file.arrayBuffer());
      validateLocationImportHeaders(headers);
      const normalized=sourceRows.flatMap((row,index)=>{
        const item=normalizeLocationImportRow(row,index+2);
        return item?[item]:[];
      });
      validateUniqueLocationImportRows(normalized);
      const response=await api("/api/v1/locations",{method:"POST",body:JSON.stringify({action:"import",rows:normalized})}) as {data?:{importedRows:number;createdRows:number;updatedRows:number}};
      if(!response.data)throw new Error("服务器没有返回库位导入结果");
      setPage(1);setDraft(null);setAdding(false);
      await done(`已导入 ${response.data.importedRows.toLocaleString()} 个库位：新增 ${response.data.createdRows.toLocaleString()} 个，更新 ${response.data.updatedRows.toLocaleString()} 个`);
    } catch(importError) {
      setError(importError instanceof Error?importError.message:"库位批量导入失败");
    } finally {
      setImporting(false);input.value="";
    }
  };
  return <section className="panel location-management"><div className="management-head"><div><h3>库位管理</h3><p>备货库位与拣货库位独立管理；即使名称相同，也属于两个不同库位。</p></div><div className="management-head-actions"><button className="location-export-button" disabled={loading||!locations.length} onClick={()=>void downloadLocationImportWorkbook(locations)}>⇩ 导出全部库位</button><a className="location-template-button" href="/neiku-location-import-template.xlsx" download="内库库位导入模板.xlsx">⇩ 下载 Excel 模板</a><label className={importing?"location-import-button busy":"location-import-button"}>⇧ {importing?"正在导入…":"批量导入库位"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importing} onChange={importLocations}/></label><button className="primary" onClick={()=>{setAdding(value=>!value);setDraft(null);setError("")}}>＋ 新增{locationTypeLabel(viewType)}</button></div></div>
    {externalError&&<div className="management-error">! {externalError}</div>}
    <div className="location-type-tabs" role="tablist" aria-label="库位类型"><button role="tab" aria-selected={viewType==="reserve"} className={viewType==="reserve"?"active":""} onClick={()=>switchType("reserve")}><span>备货库位</span><b>{counts.reserve}</b></button><button role="tab" aria-selected={viewType==="pick"} className={viewType==="pick"?"active":""} onClick={()=>switchType("pick")}><span>拣货库位</span><b>{counts.pick}</b></button></div>
    {adding&&<form className="location-create-form typed-location-create" onSubmit={create}><div className={`location-create-type ${viewType}`}><span>当前新增类型</span><b>{locationTypeLabel(viewType)}</b><small>同名的另一类型库位不会被覆盖</small></div><label>库位编码<input required value={code} onChange={e=>setCode(e.target.value.toUpperCase())} placeholder={viewType==="reserve"?"例如 A-A-001":"例如 A-1-001"}/></label><label>区域<input value={zone} onChange={e=>setZone(e.target.value.toUpperCase())} placeholder="默认取编码首段"/></label><label>托盘容量<input required type="number" min="1" max="999" value={capacity} onChange={e=>setCapacity(e.target.value)}/></label><div><button type="button" onClick={()=>setAdding(false)}>取消</button><button className="primary" disabled={busy}>{busy?"正在新增…":`确认新增${locationTypeLabel(viewType)}`}</button></div></form>}
    <div className="management-toolbar"><label>⌕<input value={q} onChange={e=>{setQ(e.target.value);setPage(1)}} placeholder={`搜索${locationTypeLabel(viewType)}或区域`}/></label><span>找到 {rows.length} 个 · 第 {page}/{totalPages} 页</span></div>
    {error&&<div className="management-error">! {error}</div>}
    <div className="table-scroll"><table className="location-management-table"><thead><tr><th>库位</th><th>类型</th><th>区域</th><th>托盘容量</th><th>已占用</th><th>可用</th><th>操作</th></tr></thead><tbody>{visibleRows.map(location=>{const editing=draft?.locationId===location.id;return <tr key={location.id}><td>{editing?<input value={draft.code} onChange={e=>setDraft({...draft,code:e.target.value.toUpperCase()})}/>:<b className="managed-location-code">{location.code}</b>}</td><td><span className={`location-type-badge ${location.type}`}>{locationTypeLabel(location.type)}</span></td><td>{editing?<input value={draft.zone} onChange={e=>setDraft({...draft,zone:e.target.value.toUpperCase()})}/>:location.zone}</td><td>{editing?<input type="number" min="1" max="999" value={draft.capacity} onChange={e=>setDraft({...draft,capacity:e.target.value})}/>:<strong>{location.capacity}</strong>}</td><td>{location.palletCount}</td><td><b className="available-count">{availableLocationSlots(location)}</b></td><td><div className="management-actions">{editing?<><button disabled={busy} onClick={save}>保存</button><button onClick={()=>setDraft(null)}>取消</button></>:<button onClick={()=>{setDraft({locationId:location.id,originalCode:location.code,originalType:location.type,code:location.code,zone:location.zone,capacity:String(location.capacity)});setAdding(false);setError("")}}>编辑</button>}</div></td></tr>})}</tbody></table></div>
    <div className="location-pagination"><span>每页最多 {pageSize} 个库位</span><div><button disabled={page<=1} onClick={()=>setPage(value=>Math.max(1,value-1))}>上一页</button><b>{page} / {totalPages}</b><button disabled={page>=totalPages} onClick={()=>setPage(value=>Math.min(totalPages,value+1))}>下一页</button></div></div>
  </section>;
}

function InventoryEditModal({row,locations,close,api,done}:{row:ReserveRow;locations:Location[];close:()=>void;api:ApiRequest;done:(m:string)=>void|Promise<void>}) {
  const pallet=row.pallet;
  const [sku,setSku]=useState(pallet?.sku??""),[locationCode,setLocationCode]=useState(row.location.code);
  const [remarks,setRemarks]=useState(pallet?.remarks??"");
  const [inboundAt,setInboundAt]=useState(pallet?toWarehouseDateTimeInput(pallet.inboundAt):"");
  const [code,setCode]=useState(row.location.code),[zone,setZone]=useState(row.location.zone),[capacity,setCapacity]=useState(String(row.location.capacity));
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const availableLocations=locations.filter(location=>location.type==="reserve"&&(location.code===row.location.code||availableLocationSlots(location)>0));
  const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{if(pallet){await api(`/api/v1/pallets/${encodeURIComponent(pallet.id)}`,{method:"PATCH",body:JSON.stringify({sku,remarks,locationCode,inboundAt:warehouseDateTimeInputToIso(inboundAt)})});await done("托盘记录已更新")}else{await api(`/api/v1/locations/${encodeURIComponent(row.location.code)}?type=reserve`,{method:"PATCH",body:JSON.stringify({code,zone,type:"reserve",capacity:Number(capacity)})});await done("备货库位记录已更新")}}catch(err){setError(err instanceof Error?err.message:"保存失败");setBusy(false)}};
  return <ModalFrame title={pallet?"编辑托盘记录":"编辑备货库位记录"} kicker="MANUAL EDIT" close={close}><form className="inventory-edit-form" onSubmit={submit}>{pallet?<><div className="readonly-pallet"><span>托盘号</span><code>{pallet.id}</code></div><label>SKU<input required value={sku} onChange={e=>setSku(e.target.value.toUpperCase())}/></label><label>备注说明<input value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="选填"/></label><label>备货库位<select required value={locationCode} onChange={e=>setLocationCode(e.target.value)}>{availableLocations.map(location=><option key={location.id} value={location.code}>{location.code}（可用 {location.code===row.location.code?Math.max(1,availableLocationSlots(location)):availableLocationSlots(location)}）</option>)}</select></label><label>入库时间（美东）<input required type="datetime-local" value={inboundAt} onChange={e=>setInboundAt(e.target.value)}/></label></>:<><div className="location-type-readonly"><span>库位类型</span><b>备货库位</b><small>库位类型是身份的一部分，不能在此转换为拣货库位</small></div><label>库位编码<input required value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/></label><label>区域<input required value={zone} onChange={e=>setZone(e.target.value.toUpperCase())}/></label><label>托盘容量<input required type="number" min="1" max="999" value={capacity} onChange={e=>setCapacity(e.target.value)}/></label></>}{error&&<div className="login-error">! {error}</div>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy}>{busy?"正在保存…":"保存修改"}</button></div></form></ModalFrame>;
}

function WarehouseLedger({pallets,locations,movements,initialTab,initialQuery,invalidSkuCodes,loading,error,api,done}:{pallets:Pallet[];locations:Location[];movements:Movement[];initialTab:LedgerTab;initialQuery:string;invalidSkuCodes:Set<string>;loading:boolean;error:string;api:ApiRequest;done:(message:string)=>void|Promise<void>}) {
  const [tab,setTab]=useState<LedgerTab>(initialTab);
  const [q,setQ]=useState(initialQuery);
  const [action,setAction]=useState("all");
  const [dateFrom,setDateFrom]=useState("");
  const [dateTo,setDateTo]=useState("");
  const [selectedSku,setSelectedSku]=useState("");
  const [selectedLocation,setSelectedLocation]=useState("");
  const [importing,setImporting]=useState(false);
  const [transferError,setTransferError]=useState("");

  const periodMovements=useMemo(()=>movements.filter(m=>
    (action==="all"||m.action===action)
    &&(!dateFrom||dateKey(m.occurredAt)>=dateFrom)
    &&(!dateTo||dateKey(m.occurredAt)<=dateTo)
  ),[movements,action,dateFrom,dateTo]);

  const skuGroups=useMemo(()=>Array.from(new Set([...pallets.map(p=>p.sku),...movements.map(m=>m.sku)])).map(sku=>{
    const current=pallets.filter(p=>p.sku===sku);
    const allEvents=movements.filter(m=>m.sku===sku);
    const events=periodMovements.filter(m=>m.sku===sku);
    const searchable=[sku,...current.flatMap(p=>[p.id,p.remarks]),...allEvents.flatMap(m=>[m.palletId,m.remarks??""])].join(" ");
    return {
      sku,currentPallets:current.length,
      locations:Array.from(new Set(current.map(p=>p.location).filter((value):value is string=>Boolean(value)))),
      events,inbound:events.filter(m=>m.action==="inbound").length,picked:events.filter(m=>["pick","partial_pick"].includes(m.action)).length,
      moved:events.filter(m=>m.action==="move").length,last:events[0]?.occurredAt??allEvents[0]?.occurredAt??null,searchable,
    };
  }).filter(group=>matchesWords(group.searchable,q)).sort((a,b)=>a.sku.localeCompare(b.sku,"zh-CN",{numeric:true})),[pallets,movements,periodMovements,q]);

  const locationGroups=useMemo(()=>locations.map(location=>{
    const current=pallets.filter(p=>p.locationId===location.id);
    const allEvents=movements.filter(m=>movementTouchesLocation(m,location));
    const events=periodMovements.filter(m=>movementTouchesLocation(m,location));
    return {
      location,current,events,allEvents,
      inbound:events.filter(m=>m.toLocation===location.code&&m.toLocationType===location.type&&!(m.fromLocation===location.code&&m.fromLocationType===location.type)).length,
      outbound:events.filter(m=>m.fromLocation===location.code&&m.fromLocationType===location.type&&!(m.toLocation===location.code&&m.toLocationType===location.type)).length,
      last:events[0]?.occurredAt??allEvents[0]?.occurredAt??null,
      searchable:[location.code,location.zone,locationTypeLabel(location.type),...current.map(p=>p.sku),...allEvents.flatMap(m=>[m.sku,m.palletId])].join(" "),
    };
  }).filter(group=>matchesWords(group.searchable,q)).sort((a,b)=>a.location.code.localeCompare(b.location.code,"zh-CN",{numeric:true})||a.location.type.localeCompare(b.location.type)),[locations,pallets,movements,periodMovements,q]);

  const activeSku=skuGroups.some(group=>group.sku===selectedSku)?selectedSku:skuGroups[0]?.sku??"";
  const skuDetail=skuGroups.find(group=>group.sku===activeSku);
  const activeLocation=locationGroups.some(group=>String(group.location.id)===selectedLocation)?selectedLocation:String(locationGroups[0]?.location.id??"");
  const locationDetail=locationGroups.find(group=>String(group.location.id)===activeLocation);
  const historyRows=periodMovements.filter(m=>matchesWords([m.sku,m.remarks??"",m.palletId,m.taskId??"",m.operator??"",m.fromLocation??"",m.toLocation??""].join(" "),q));
  const touchedLocations=new Set(movements.flatMap(m=>[
    m.fromLocation?`${m.fromLocationType??"unknown"}:${m.fromLocation}`:null,
    m.toLocation?`${m.toLocationType??"unknown"}:${m.toLocation}`:null,
  ].filter((value):value is string=>Boolean(value)))).size;
  const filtersActive=Boolean(q||action!=="all"||dateFrom||dateTo);
  const changeTab=(next:LedgerTab)=>{setTab(next);setQ("");setSelectedSku("");setSelectedLocation("")};
  const clearFilters=()=>{setQ("");setAction("all");setDateFrom("");setDateTo("")};
  const placeholder=tab==="sku"?"搜索 SKU、托盘号或备注":tab==="location"?"搜索库位、SKU 或托盘号":"搜索 SKU、托盘号、备注、库位、任务号或操作人";
  const importLedger=async(event:ChangeEvent<HTMLInputElement>)=>{
    const input=event.currentTarget,file=input.files?.[0];
    if(!file)return;
    setImporting(true);setTransferError("");
    try {
      if(!file.name.toLowerCase().endsWith(".xlsx"))throw new Error("请选择 .xlsx 格式的仓库台账文件");
      const {headers,rows:sourceRows}=await readNamedWorksheet(await file.arrayBuffer(),WAREHOUSE_LEDGER_HISTORY_SHEET);
      validateWarehouseLedgerHeaders(headers);
      const normalized=sourceRows.flatMap((row,index)=>{
        const item=normalizeWarehouseLedgerRow(row,index+2);
        return item?[item]:[];
      });
      validateWarehouseLedgerRows(normalized);
      const response=await api("/api/v1/movements",{method:"POST",body:JSON.stringify({action:"import",rows:normalized})}) as {data?:{importedRows:number;createdRows:number;skippedRows:number}};
      if(!response.data)throw new Error("服务器没有返回台账导入结果");
      await done(`仓库台账导入完成：新增 ${response.data.createdRows.toLocaleString()} 条，跳过已有 ${response.data.skippedRows.toLocaleString()} 条`);
    } catch(importError) {
      setTransferError(importError instanceof Error?importError.message:"仓库台账导入失败");
    } finally {
      setImporting(false);input.value="";
    }
  };
  const exportLedger=async()=>{
    setTransferError("");
    try {await downloadWarehouseLedgerWorkbook(movements,pallets,locations)}
    catch(exportError){setTransferError(exportError instanceof Error?exportError.message:"仓库台账导出失败")}
  };

  return <section className="panel warehouse-ledger">
    <div className="ledger-overview">
      <div><span>WAREHOUSE LEDGER</span><h2>仓库台账</h2><p>完整记录 SKU、库位与每一次托盘移动</p></div>
      <div className="ledger-overview-right"><div className="ledger-transfer-actions"><label className={importing?"busy":""}>⇧ {importing?"正在导入…":"导入仓库台账"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={importing||loading} onChange={importLedger}/></label><button disabled={loading||!movements.length} onClick={()=>void exportLedger()}>⇩ 导出全部台账</button></div><div className="ledger-overview-stats"><p><b>{new Set(movements.map(m=>m.sku)).size}</b><span>历史 SKU</span></p><p><b>{touchedLocations}</b><span>有记录库位</span></p><p><b>{movements.length}</b><span>操作记录</span></p></div></div>
    </div>
    {error&&<div className="management-error">! {error}</div>}
    {transferError&&<div className="management-error">! {transferError}</div>}
    <div className="ledger-tabs" role="tablist" aria-label="仓库台账分类">
      <button role="tab" aria-selected={tab==="sku"} className={tab==="sku"?"active":""} onClick={()=>changeTab("sku")}>SKU 台账</button>
      <button role="tab" aria-selected={tab==="location"} className={tab==="location"?"active":""} onClick={()=>changeTab("location")}>库位台账</button>
      <button role="tab" aria-selected={tab==="history"} className={tab==="history"?"active":""} onClick={()=>changeTab("history")}>操作历史</button>
    </div>
    <div className="ledger-filters">
      <label className="ledger-search"><span>⌕</span><input aria-label={placeholder} value={q} onChange={e=>setQ(e.target.value)} placeholder={placeholder}/></label>
      <select aria-label="台账动作" value={action} onChange={e=>setAction(e.target.value)}><option value="all">全部动作</option>{Object.entries(actionLabel).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select>
      <label className="ledger-date"><span>开始日期</span><input type="date" value={dateFrom} max={dateTo||undefined} onChange={e=>setDateFrom(e.target.value)}/></label>
      <label className="ledger-date"><span>结束日期</span><input type="date" value={dateTo} min={dateFrom||undefined} onChange={e=>setDateTo(e.target.value)}/></label>
      <button className="ledger-reset" disabled={!filtersActive} onClick={clearFilters}>重置</button>
    </div>

    {tab==="sku"&&<div className="ledger-master-detail">
      <aside className="ledger-master-list">
        <div className="ledger-list-head"><b>SKU</b><span>{skuGroups.length} 项</span></div>
        <div className="ledger-list-scroll">{skuGroups.map(group=><button key={group.sku} className={activeSku===group.sku?"active":""} onClick={()=>setSelectedSku(group.sku)}>
          <span><b className={invalidSkuCodes.has(group.sku)?"invalid-sku":""}>{group.sku}</b><small>{group.currentPallets} 托在库 · {group.events.length} 条记录</small></span><time>{group.last?formatLedgerTime(group.last):"暂无记录"}</time>
        </button>)}{!skuGroups.length&&<Empty text="没有符合条件的 SKU"/>}</div>
      </aside>
      <div className="ledger-detail">
        {skuDetail?<><div className="ledger-detail-head"><div><span>SKU 完整流转</span><h3 className={invalidSkuCodes.has(skuDetail.sku)?"invalid-sku":""}>{skuDetail.sku}</h3><p>{skuDetail.locations.length?`当前存放：${skuDetail.locations.join("、")}`:"当前无备货库存"}</p></div><div className="ledger-summary-cards"><p><b>{skuDetail.currentPallets}</b><span>当前托盘</span></p><p><b>{skuDetail.inbound}</b><span>存备货</span></p><p><b>{skuDetail.picked}</b><span>取备货</span></p><p><b>{skuDetail.moved}</b><span>区内迁移</span></p></div></div><LedgerMovementTable rows={skuDetail.events} invalidSkuCodes={invalidSkuCodes}/></>:<Empty text="请选择 SKU 查看流转明细"/>}
      </div>
    </div>}

    {tab==="location"&&<div className="ledger-master-detail">
      <aside className="ledger-master-list">
        <div className="ledger-list-head"><b>库位</b><span>{locationGroups.length} 项</span></div>
        <div className="ledger-list-scroll">{locationGroups.map(group=><button key={group.location.id} className={activeLocation===String(group.location.id)?"active":""} onClick={()=>setSelectedLocation(String(group.location.id))}>
          <span><b>{group.location.code}</b><small>{locationTypeLabel(group.location.type)} · {group.current.length}/{group.location.capacity} 托</small></span><time>{group.last?formatLedgerTime(group.last):"暂无记录"}</time>
        </button>)}{!locationGroups.length&&<Empty text="没有符合条件的库位"/>}</div>
      </aside>
      <div className="ledger-detail">
        {locationDetail?<><div className="ledger-detail-head"><div><span>库位完整历史 · {locationTypeLabel(locationDetail.location.type)}</span><h3>{locationDetail.location.code}</h3><p>当前货物：{locationDetail.current.length?locationDetail.current.map((p,index)=><Fragment key={p.id}>{index>0?"、":""}<b className={invalidSkuCodes.has(p.sku)?"invalid-sku":""}>{p.sku}</b>（{p.id}）</Fragment>):"空库位"}</p></div><div className="ledger-summary-cards location-summary"><p><b>{locationDetail.current.length}/{locationDetail.location.capacity}</b><span>当前占用</span></p><p><b>{locationDetail.inbound}</b><span>移入记录</span></p><p><b>{locationDetail.outbound}</b><span>移出记录</span></p></div></div><LedgerMovementTable rows={locationDetail.events} location={locationDetail.location} invalidSkuCodes={invalidSkuCodes}/></>:<Empty text="请选择库位查看历史明细"/>}
      </div>
    </div>}

    {tab==="history"&&<div className="ledger-history"><div className="ledger-history-head"><div><b>全部操作记录</b><span>按时间倒序，当前显示 {historyRows.length} 条</span></div></div><LedgerMovementTable rows={historyRows} invalidSkuCodes={invalidSkuCodes}/></div>}
  </section>;
}

function LedgerMovementTable({rows,location,invalidSkuCodes}:{rows:Movement[];location?:Location;invalidSkuCodes:Set<string>}) {
  if(!rows.length)return <Empty text="当前条件下没有历史记录"/>;
  const orderedRows=sortMovementsNewestFirst(rows);
  return <div className="ledger-table-scroll"><table className="ledger-table"><thead><tr><th>时间（美东）</th><th>{location?"库位变化":"动作"}</th><th>SKU</th><th>移动路径</th><th>托盘号</th><th>备注说明</th><th>任务 / 操作人</th></tr></thead><tbody>{orderedRows.map(m=>{
    const direction=location?locationMovementDirection(m,location):null;
    return <tr key={m.id}><td><time>{formatLedgerTime(m.occurredAt)}</time></td><td>{direction?<><span className={`ledger-direction ${direction.tone}`}>{direction.label}</span><small className="ledger-action-note">{actionLabel[m.action]}</small></>:<span className={`ledger-action action-${m.action}`}>{actionLabel[m.action]}</span>}</td><td><b className={invalidSkuCodes.has(m.sku)?"ledger-sku invalid-sku":"ledger-sku"}>{m.sku}</b></td><td><span className="ledger-route"><b>{formatMovementLocation(m.fromLocation,m.fromLocationType,"仓外")}</b><i>→</i><b>{formatMovementLocation(m.toLocation,m.toLocationType,"出库")}</b></span></td><td><code>{m.palletId}</code></td><td><span className={m.remarks?.trim()?"ledger-remarks":"ledger-remarks empty"}>{m.remarks?.trim()||"无备注"}</span></td><td><span className="ledger-meta">{m.taskId??"直接操作"}<small>{m.operator??"系统记录"}</small></span></td></tr>;
  })}</tbody></table></div>;
}

function TasksView({tasks,onTask,invalidSkuCodes,error}:{tasks:TaskGroup[];onTask:(t:Task)=>void;invalidSkuCodes:Set<string>;error:string}) {
  const [tab,setTab]=useState("open");
  const lines=tasks.flatMap(group=>group.rows.map((row,index)=>({task:row,index,total:group.rows.length})));
  const pendingGroups=tasks.filter(group=>group.rows.some(row=>taskItemResult(row).key==="pending"));
  return <section className="panel task-page">
    <div className="tabs task-tabs">
      <button className={tab==="open"?"on":""} onClick={()=>setTab("open")}>待处理 <span>{pendingGroups.length}</span></button>
      <button className={tab==="all"?"on":""} onClick={()=>setTab("all")}>全部 <span>{lines.length}</span></button>
    </div>
    {error&&<div className="management-error">! {error}</div>}
    {tab==="open"?<div className="task-list">{pendingGroups.length?pendingGroups.map(group=><TaskRow key={group.task.id} task={group.task} rows={group.rows} onClick={()=>onTask(group.task)} invalidSkuCodes={invalidSkuCodes}/>):<Empty text="当前没有待处理任务"/>}</div>:<div className="task-lines-scroll"><div className="task-lines-table">
      <div className="task-line-head"><span>任务 / 子任务</span><span>SKU</span><span>备货库位 / 起始库位</span><span>主库位 / 目标库位</span><span>托盘参考</span><span>作业结果</span><span>操作</span></div>
      {lines.length?lines.map(line=><TaskSubtaskRow key={`${line.task.id}-${line.task.palletId??line.index}`} task={line.task} index={line.index} total={line.total} onClick={()=>onTask(line.task)} invalidSkuCodes={invalidSkuCodes}/>):<Empty text="暂无任务明细"/>}
    </div></div>}
  </section>;
}

function TaskSubtaskRow({task,index,total,onClick,invalidSkuCodes}:{task:Task;index:number;total:number;onClick:()=>void;invalidSkuCodes:Set<string>}) {
  const tone=task.type==="pick"?"blue":task.type==="move"?"amber":"green";
  const result=taskItemResult(task);
  return <article className="task-subtask-row">
    <div className="task-line-identity"><span className={`type ${tone}`}>{typeLabel[task.type]}</span><b>{task.id}</b><small>子任务 {index+1} / {total}</small></div>
    <div className="task-line-sku-block task-line-major"><span className="task-line-field-label">SKU</span><b className={task.sku&&invalidSkuCodes.has(task.sku)?"task-line-sku invalid-sku":"task-line-sku"}>{task.sku??"—"}</b>{task.itemNote&&<small>备注：{task.itemNote}</small>}</div>
    <div className="task-line-major"><span className="task-line-field-label">备货库位 / 起始库位</span><b className="task-line-location">{formatMovementLocation(task.fromLocation,task.fromLocationType,"收货暂存区")}</b></div>
    <div className="task-line-major"><span className="task-line-field-label">主库位 / 目标库位</span><b className="task-line-location">{formatMovementLocation(task.toLocation,task.toLocationType,"待分配")}</b></div>
    <div className="task-line-major"><span className="task-line-field-label">托盘参考</span><code className="task-line-pallet">{task.palletId??"—"}</code></div>
    <div className="task-line-major task-line-result-cell"><span className="task-line-field-label">作业结果</span><span className={`task-line-result ${result.key}`}>{result.label}</span></div>
    <button className="task-line-action" onClick={onClick}>{result.key==="pending"?"处理":"详情"}</button>
  </article>;
}

function TaskRow({task,rows,onClick,invalidSkuCodes}:{task:Task;rows:Task[];onClick:()=>void;invalidSkuCodes:Set<string>}) {
  const tone=task.type==="pick"?"blue":task.type==="move"?"amber":"green";
  const sourceLabel=task.type==="pick"?"备货库位":"起始库位";
  const targetLabel=task.type==="pick"?"主库位":"目标库位";
  return <article className="task"><div className={`task-symbol ${tone}`}>{task.type==="pick"?"↗":task.type==="move"?"↔":"↓"}</div><div className="task-main"><div><span className={`type ${tone}`}>{typeLabel[task.type]}</span><strong>{task.id}</strong><small className={task.priority==="urgent"?"urgent":""}>{task.priority==="urgent"?"紧急":"普通"}</small></div>{task.type==="pick"?<ul className="task-subtask-summaries">{rows.map((row,index)=><li key={row.palletId??index}><span className="task-summary-part">SKU：<b className={row.sku&&invalidSkuCodes.has(row.sku)?"invalid-sku":""}>{row.sku??"—"}</b></span><span className="task-summary-part">备货库位：{row.fromLocation??"—"}</span><span className="task-summary-part">主库位：{row.toLocation??"—"}</span>{row.itemNote&&<small>备注：{row.itemNote}</small>}</li>)}</ul>:<><b>SKU：<span className={task.sku&&invalidSkuCodes.has(task.sku)?"invalid-sku":""}>{task.sku??task.note??"批量任务"}</span></b><p><span>{sourceLabel}：{formatMovementLocation(task.fromLocation,task.fromLocationType,"收货暂存区")}</span><em>·</em><span>{targetLabel}：{formatMovementLocation(task.toLocation,task.toLocationType,"待分配")}</span></p></>}</div><div className="task-meta"><span>{taskStatusLabel[task.status]}</span><button onClick={onClick}>{["pending","claimed"].includes(task.status)?"处理":"详情"}</button></div></article>;
}

function TaskCreateModal({type,pallets,locations,selected,close,done,api,locationsLoading,locationsError}:{type:"store"|"pick"|"move";pallets:Pallet[];locations:Location[];selected:string[];close:()=>void;done:(m:string)=>void;api:ApiRequest;locationsLoading:boolean;locationsError:string}) {
  const available=pallets.filter(p=>p.status==="in_stock");
  const targets=locations.filter(location=>location.type===(type==="pick"?"pick":"reserve")&&(type==="pick"||availableLocationSlots(location)>0));
  const targetSlots=type==="pick"?targets.map(location=>location.code):targets.flatMap(location=>Array.from({length:availableLocationSlots(location)},()=>location.code));
  const initialPickRows=selected.flatMap((palletId,index)=>{
    const pallet=available.find(item=>item.id===palletId);
    return pallet?[{key:index+1,sku:pallet.sku,palletId:pallet.id,target:"",note:""}]:[];
  });
  const initialMoveRows=selected.flatMap((palletId,index)=>{
    const pallet=available.find(item=>item.id===palletId);
    return pallet?[{key:index+1,sku:pallet.sku,palletId:pallet.id,target:""}]:[];
  });
  const [storeRows,setStoreRows]=useState([{key:1,sku:"",remarks:"",target:""}]);
  const [pickRows,setPickRows]=useState(initialPickRows.length?initialPickRows:[{key:1,sku:"",palletId:"",target:"",note:""}]);
  const [moveRows,setMoveRows]=useState(initialMoveRows.length?initialMoveRows:[{key:1,sku:"",palletId:"",target:""}]);
  const [busy,setBusy]=useState(false),[pdfBusy,setPdfBusy]=useState(false),[error,setError]=useState("");
  const updateStore=(key:number,patch:Partial<(typeof storeRows)[number]>)=>setStoreRows(rows=>rows.map(row=>row.key===key?{...row,...patch}:row));
  const updatePick=(key:number,patch:Partial<(typeof pickRows)[number]>)=>setPickRows(rows=>rows.map(row=>row.key===key?{...row,...patch}:row));
  const updateMove=(key:number,patch:Partial<(typeof moveRows)[number]>)=>setMoveRows(rows=>rows.map(row=>row.key===key?{...row,...patch}:row));
  const targetHasRoom=(code:string,assigned:string[])=>assigned.filter(value=>value===code).length<(targets.find(location=>location.code===code)?availableLocationSlots(targets.find(location=>location.code===code)!):0);
  const addStoreRow=()=>{
    if(storeRows.length>=targetSlots.length)return;
    setStoreRows(rows=>[...rows,{key:Math.max(...rows.map(row=>row.key))+1,sku:"",remarks:"",target:""}]);
  };
  const addPickRow=()=>{
    if(pickRows.length>=available.length)return;
    setPickRows(rows=>[...rows,{key:Math.max(0,...rows.map(row=>row.key))+1,sku:"",palletId:"",target:"",note:""}]);
  };
  const addMoveRow=()=>{
    if(moveRows.length>=Math.min(available.length,targetSlots.length))return;
    setMoveRows(rows=>[...rows,{key:Math.max(0,...rows.map(row=>row.key))+1,sku:"",palletId:"",target:""}]);
  };
  const submit=async()=>{
    setBusy(true);setError("");
    try{
      if(type==="store") {
        const items=storeRows.map(row=>({
          sku:row.sku,
          remarks:row.remarks.trim(),
          toLocationCode:row.target,
        }));
        await api("/api/v1/pallets/inbound",{method:"POST",body:JSON.stringify({items})});
        done(`${storeRows.length} 托备货已直接入库`);
        return;
      }
      const payload=type==="move"
        ?{type,moveItems:moveRows.map(row=>({palletId:row.palletId,toLocationCode:row.target}))}
        :{type,pickItems:pickRows.map(row=>({palletId:row.palletId,toLocationCode:row.target,note:row.note.trim()}))};
      await api("/api/v1/tasks",{method:"POST",body:JSON.stringify(payload)});done(`${typeLabel[type]}待办已创建`);
    }
    catch(e){setError(e instanceof Error?e.message:type==="store"?"入库失败":"创建失败");setBusy(false)}
  };
  const storeMissingSku=storeRows.some(row=>!row.sku.trim());
  const storeAtCapacity=storeRows.length>=targetSlots.length;
  const storeAssignments=storeRows.map(row=>row.target);
  const moveAssignments=moveRows.map(row=>row.target);
  const assignmentsFit=(assigned:string[])=>targets.every(location=>assigned.filter(code=>code===location.code).length<=(type==="pick"?Number.MAX_SAFE_INTEGER:availableLocationSlots(location)));
  const storeInvalid=storeMissingSku||storeRows.some(row=>!row.target)||!assignmentsFit(storeAssignments);
  const selectedMovePalletIds=moveRows.map(row=>row.palletId).filter(Boolean);
  const moveInvalid=!moveRows.length||moveRows.some(row=>{
    const pallet=available.find(item=>item.id===row.palletId);
    return !row.sku.trim()||!pallet||pallet.sku!==row.sku.trim().toUpperCase()||!row.target||pallet.location===row.target;
  })||new Set(selectedMovePalletIds).size!==selectedMovePalletIds.length||!assignmentsFit(moveAssignments);
  const moveAtCapacity=moveRows.length>=Math.min(available.length,targetSlots.length);
  const selectedPickPalletIds=pickRows.map(row=>row.palletId).filter(Boolean);
  const validPickTargetCodes=new Set(targets.map(location=>location.code));
  const pickInvalid=!pickRows.length||pickRows.some(row=>{
    const pallet=available.find(item=>item.id===row.palletId);
    return !row.sku.trim()||!pallet||pallet.sku!==row.sku.trim().toUpperCase()||!validPickTargetCodes.has(row.target.trim().toUpperCase());
  })||new Set(selectedPickPalletIds).size!==selectedPickPalletIds.length;
  const pickAtCapacity=pickRows.length>=available.length;
  const printPickSheet=async()=>{
    const sheetRows=pickRows.flatMap(row=>{
      const pallet=available.find(item=>item.id===row.palletId);
      return pallet?[{sku:pallet.sku,fromLocation:pallet.location??"",toLocation:row.target,note:row.note.trim()}]:[];
    });
    setPdfBusy(true);setError("");
    try{await printWarehouseTaskSheet({taskId:"待创建",type:"pick",rows:sheetRows})}
    catch(e){setError(e instanceof Error?e.message:"PDF 作业单打印失败")}
    finally{setPdfBusy(false)}
  };
  const printMoveSheet=async()=>{
    const sheetRows=moveRows.flatMap(row=>{
      const pallet=available.find(item=>item.id===row.palletId);
      return pallet?[{sku:pallet.sku,fromLocation:pallet.location??"",toLocation:row.target}]:[];
    });
    setPdfBusy(true);setError("");
    try{await printWarehouseTaskSheet({taskId:"待创建",type:"move",rows:sheetRows})}
    catch(e){setError(e instanceof Error?e.message:"PDF 作业单打印失败")}
    finally{setPdfBusy(false)}
  };
  return <ModalFrame title={typeLabel[type]} kicker={type==="store"?"DIRECT PUTAWAY":type==="pick"?"BATCH PICK TASK":"BATCH MOVE TASK"} close={close} wide>
    <div className={type==="store"?"flow-summary store-flow-summary":type==="pick"?"flow-summary pick-flow-summary":"flow-summary move-flow-summary"}>
      {locationsError&&<div className="login-error">! {locationsError}</div>}
      {type==="store"?<><p className="store-guidance">可先添加多行再统一填写。同一库位可按托盘容量分配多行；每行的 SKU 和备货库位为必填，备注说明选填。</p><div className="store-lines"><div className="store-grid-head"><span>SKU <b>*</b></span><span>备注说明</span><span>备货库位 <b>*</b></span><span/></div>{storeRows.map((row,index)=>{const otherAssignments=storeRows.filter(item=>item.key!==row.key).map(item=>item.target);return <div className="store-line" key={row.key}><label><span>SKU *</span><input required aria-label={`SKU ${index+1}`} placeholder="必填" value={row.sku} onChange={e=>updateStore(row.key,{sku:e.target.value.toUpperCase()})}/></label><label><span>备注说明</span><input aria-label={`备注说明 ${index+1}`} placeholder="选填" value={row.remarks} onChange={e=>updateStore(row.key,{remarks:e.target.value})}/></label><label><span>备货库位 *</span><select required aria-label={`备货库位 ${index+1}`} value={row.target} onChange={e=>updateStore(row.key,{target:e.target.value})}><option value="">选择库位</option>{targets.filter(location=>location.code===row.target||targetHasRoom(location.code,otherAssignments)).map(location=><option key={location.id} value={location.code}>{location.code}（余 {availableLocationSlots(location)-otherAssignments.filter(code=>code===location.code).length}）</option>)}</select></label>{storeRows.length>1?<button className="remove-store-line" aria-label={`移除第 ${index+1} 行`} onClick={()=>setStoreRows(rows=>rows.filter(item=>item.key!==row.key))}>移除</button>:<span className="remove-store-placeholder"/>}</div>})}<button className="add-line" disabled={storeAtCapacity} onClick={addStoreRow}>＋ 添加一行</button></div>{storeAtCapacity&&<p className="store-capacity-hint">备货库位已满，无法继续添加。</p>}{storeRows.length>1&&storeMissingSku&&<p className="store-validation-hint">请填写每一行的 SKU 后再存入备货区。</p>}</>
      :type==="pick"?<>
        <p className="pick-guidance">每行先输入 SKU，再选择该 SKU 的备货库位和主库位；每个子任务均可填写一条独立备注。可一次建立多条取备货明细。</p>
        <datalist id="pick-sku-options">{Array.from(new Set(available.map(p=>p.sku))).sort().map(sku=><option key={sku} value={sku}/>)}</datalist>
        <div className="pick-lines">
          <div className="pick-grid-head"><span>SKU <b>*</b></span><span>备货库位 / 托盘 <b>*</b></span><span>主库位 <b>*</b></span><span/></div>
          {pickRows.map((row,index)=>{
            const otherSelected=pickRows.filter(item=>item.key!==row.key).map(item=>item.palletId);
            const matchingPallets=available.filter(p=>p.sku===row.sku.trim().toUpperCase()&&(p.id===row.palletId||!otherSelected.includes(p.id)));
            const targetOptionsId=`pick-target-options-${row.key}`;
            const matchingTargets=findLocationMatches(targets,row.target,100);
            return <div className="pick-line" key={row.key}>
              <label><span>SKU *</span><input list="pick-sku-options" aria-label={`取备货 SKU ${index+1}`} placeholder="输入或选择 SKU" value={row.sku} onChange={event=>updatePick(row.key,{sku:event.target.value.toUpperCase(),palletId:""})}/></label>
              <label><span>备货库位 / 托盘 *</span><select aria-label={`备货库位 ${index+1}`} value={row.palletId} disabled={!row.sku.trim()} onChange={e=>updatePick(row.key,{palletId:e.target.value})}><option value="">{row.sku.trim()?matchingPallets.length?"选择该 SKU 的备货库位":"该 SKU 无可用备货":"请先输入 SKU"}</option>{matchingPallets.map(p=><option key={p.id} value={p.id}>{p.location} · {p.id}{p.remarks?` · ${p.remarks}`:""}</option>)}</select></label>
              <label><span>主库位 *</span><input list={targetOptionsId} aria-label={`主库位 ${index+1}`} placeholder="输入或选择主库位" value={row.target} onChange={event=>updatePick(row.key,{target:event.target.value.toUpperCase()})}/><datalist id={targetOptionsId}>{matchingTargets.map(location=><option key={location.id} value={location.code}/>)}</datalist></label>
              {pickRows.length>1?<button className="remove-pick-line" aria-label={`移除第 ${index+1} 条取备货`} onClick={()=>setPickRows(rows=>rows.filter(item=>item.key!==row.key))}>移除</button>:<span className="remove-pick-placeholder"/>}
              <label className="pick-line-note"><span>子任务备注</span><input aria-label={`取备货子任务备注 ${index+1}`} maxLength={500} placeholder="选填：填写本托作业注意事项" value={row.note} onChange={event=>updatePick(row.key,{note:event.target.value})}/></label>
            </div>;
          })}
          <button className="add-pick-line" disabled={pickAtCapacity} onClick={addPickRow}>＋ 添加一条取备货</button>
        </div>
        {pickAtCapacity&&available.length>0&&<p className="pick-capacity-hint">已达到当前可用备货托盘数量。</p>}
      </>
      :<><p className="pick-guidance move-guidance">每行先输入 SKU，再选择该 SKU 当前所在的备货库位和托盘，最后从仍有空托盘位的备货库位中选择迁移目标。</p><datalist id="move-sku-options">{Array.from(new Set(available.map(p=>p.sku))).sort().map(sku=><option key={sku} value={sku}/>)}</datalist><div className="pick-lines move-lines"><div className="pick-grid-head"><span>SKU <b>*</b></span><span>当前备货库位 / 托盘 <b>*</b></span><span>目标备货空位 <b>*</b></span><span/></div>{moveRows.map((row,index)=>{const otherSelected=moveRows.filter(item=>item.key!==row.key).map(item=>item.palletId);const otherTargets=moveRows.filter(item=>item.key!==row.key).map(item=>item.target);const matchingPallets=available.filter(p=>p.sku===row.sku.trim().toUpperCase()&&(p.id===row.palletId||!otherSelected.includes(p.id)));const sourcePallet=available.find(p=>p.id===row.palletId);const availableTargets=targets.filter(location=>location.code!==sourcePallet?.location&&(location.code===row.target||targetHasRoom(location.code,otherTargets)));return <div className="pick-line move-line" key={row.key}><label><span>SKU *</span><input list="move-sku-options" aria-label={`迁移备货 SKU ${index+1}`} placeholder="输入或选择 SKU" value={row.sku} onChange={e=>updateMove(row.key,{sku:e.target.value.toUpperCase(),palletId:"",target:""})}/></label><label><span>当前备货库位 / 托盘 *</span><select aria-label={`当前备货库位 ${index+1}`} value={row.palletId} disabled={!row.sku.trim()} onChange={e=>updateMove(row.key,{palletId:e.target.value,target:""})}><option value="">{row.sku.trim()?matchingPallets.length?"选择该 SKU 的当前库位":"该 SKU 无可迁移备货":"请先输入 SKU"}</option>{matchingPallets.map(p=><option key={p.id} value={p.id}>{p.location} · {p.id}{p.remarks?` · ${p.remarks}`:""}</option>)}</select></label><label><span>目标备货空位 *</span><select aria-label={`目标备货空位 ${index+1}`} value={row.target} disabled={!row.palletId} onChange={e=>updateMove(row.key,{target:e.target.value})}><option value="">{row.palletId?availableTargets.length?"选择有空位的备货库位":"暂无可用备货空位":"请先选择当前库位"}</option>{availableTargets.map(location=>{const remaining=availableLocationSlots(location)-otherTargets.filter(code=>code===location.code).length;return <option key={location.id} value={location.code}>{location.code}（空位 {remaining}）</option>})}</select></label>{moveRows.length>1?<button className="remove-pick-line" aria-label={`移除第 ${index+1} 条迁移备货`} onClick={()=>setMoveRows(rows=>rows.filter(item=>item.key!==row.key))}>移除</button>:<span className="remove-pick-placeholder"/>}</div>})}<button className="add-pick-line move-add-line" disabled={moveAtCapacity} onClick={addMoveRow}>＋ 添加一条迁移备货</button></div>{moveAtCapacity&&targetSlots.length>0&&<p className="pick-capacity-hint">已达到当前备货区空托盘位数量。</p>}</>}
      {!locationsLoading&&!locationsError&&!targets.length&&<div className="login-error">! 当前没有可分配的目标库位</div>}{error&&<div className="login-error">! {error}</div>}
    </div>
    <div className="modal-actions">{type==="pick"&&<button className="pick-pdf-action" disabled={busy||pdfBusy||locationsLoading||pickInvalid} onClick={printPickSheet}>▤ {pdfBusy?"正在准备打印…":"打印PDF作业单"}</button>}{type==="move"&&<button className="pick-pdf-action" disabled={busy||pdfBusy||moveInvalid} onClick={printMoveSheet}>▤ {pdfBusy?"正在准备打印…":"打印PDF作业单"}</button>}<button onClick={close}>取消</button><button className="primary" disabled={busy||pdfBusy||locationsLoading||!targets.length||(type==="store"?storeInvalid:type==="move"?moveInvalid:pickInvalid)} onClick={submit}>{busy?(type==="store"?"正在存入…":"正在创建…"):(type==="store"?"存入备货区":"创建待办")}</button></div>
  </ModalFrame>;
}

function TaskModal({task,rows,close,api,done,updated,invalidSkuCodes}:{task:Task;rows:Task[];close:()=>void;api:ApiRequest;done:(m:string)=>void;updated:(m:string)=>Promise<void>;invalidSkuCodes:Set<string>}) {
  const [busy,setBusy]=useState(false),[busyPallet,setBusyPallet]=useState<string|null>(null),[pdfBusy,setPdfBusy]=useState(false),[error,setError]=useState("");
  const open=["pending","claimed"].includes(task.status);
  const finish=async(outcome:"completed"|"returned")=>{setBusy(true);setError("");try{await api(`/api/v1/tasks/${task.id}/complete`,{method:"POST",body:JSON.stringify({outcome})});done(outcome==="completed"?"任务已完成，库存与历史已更新":"货物已退回原备货库位")}catch(e){setError(e instanceof Error?e.message:"操作失败");setBusy(false)}};
  const finishPickItem=async(row:Task,outcome:"completed"|"returned"|"partial")=>{
    if(!row.palletId)return;
    setBusyPallet(row.palletId);setError("");
    try{
      await api(`/api/v1/tasks/${task.id}/complete`,{method:"POST",body:JSON.stringify({palletId:row.palletId,outcome})});
      await updated(outcome==="completed"?`SKU ${row.sku??""} 已确认全部取出`:outcome==="returned"?`SKU ${row.sku??""} 已确认退回库位`:`SKU ${row.sku??""} 已确认部分取出`);
    }catch(e){setError(e instanceof Error?e.message:"操作失败")}
    finally{setBusyPallet(null)}
  };
  const printPdf=async()=>{
    setPdfBusy(true);setError("");
    try{await printWarehouseTaskSheet({taskId:task.id,type:task.type,rows:rows.map(row=>({sku:row.sku??"",fromLocation:row.fromLocation??"收货暂存区",toLocation:row.toLocation??"",note:row.itemNote??""}))})}
    catch(e){setError(e instanceof Error?e.message:"PDF 作业单打印失败")}
    finally{setPdfBusy(false)}
  };
  return <ModalFrame title={`${typeLabel[task.type]} · ${task.id}`} kicker={`TASK / ${taskStatusLabel[task.status]}`} close={close} wide={task.type==="pick"}><div className="task-detail">
    {task.type==="pick"?<div className="pick-task-items">{rows.map((row,index)=>{
      const outcome=pickItemOutcome(row);
      const itemBusy=busyPallet===row.palletId;
      return <article className={`pick-task-item${outcome?" resolved":""}`} key={row.palletId??index}>
        <div className="pick-task-item-head"><b>第 {index+1} 托</b>{outcome&&<span className={`pick-item-status ${outcome}`}>{outcome==="completed"?"已全部取出":outcome==="returned"?"已退回库位":"已部分取出"}</span>}</div>
        <dl className="pick-task-route">
          <div className="pick-task-sku"><dt>SKU</dt><dd className={row.sku&&invalidSkuCodes.has(row.sku)?"invalid-sku":""}>{row.sku??"—"}</dd></div>
          <div><dt>备货库位</dt><dd>{row.fromLocation??"—"}</dd></div>
          <div><dt>主库位</dt><dd>{row.toLocation??"—"}</dd></div>
        </dl>
        {row.palletId&&<small className="pick-pallet-reference">托盘号：{row.palletId}</small>}
        {row.palletRemarks&&<small className="pick-pallet-remarks">备注说明：{row.palletRemarks}</small>}
        {row.itemNote&&<small className="pick-task-note">子任务备注：{row.itemNote}</small>}
        <p className="pick-subtask-summary"><span>SKU：<b className={row.sku&&invalidSkuCodes.has(row.sku)?"invalid-sku":""}>{row.sku??"—"}</b></span><span>备货库位：{row.fromLocation??"—"}</span><span>主库位：{row.toLocation??"—"}</span></p>
        {open&&!outcome&&row.palletId&&<div className="pick-item-actions">
          <button className="pick-complete" disabled={Boolean(busyPallet)||pdfBusy} onClick={()=>finishPickItem(row,"completed")}>{itemBusy?"处理中…":"全部取出"}</button>
          <button className="pick-partial" disabled={Boolean(busyPallet)||pdfBusy} onClick={()=>finishPickItem(row,"partial")}>部分取出</button>
          <button className="pick-return" disabled={Boolean(busyPallet)||pdfBusy} onClick={()=>finishPickItem(row,"returned")}>退回库位</button>
        </div>}
      </article>;
    })}</div>:<>
      <div className="task-item-list">{rows.map((row,index)=><div className="task-item-detail" key={row.palletId??index}><p><b>SKU：<span className={row.sku&&invalidSkuCodes.has(row.sku)?"invalid-sku":""}>{row.sku??"新托盘"}</span></b><small>起始库位：{formatMovementLocation(row.fromLocation,row.fromLocationType,"收货暂存区")} · 目标库位：{formatMovementLocation(row.toLocation,row.toLocationType,"待分配")}</small>{row.palletId&&<em>托盘参考：{row.palletId}</em>}{row.palletRemarks&&<small>备注说明：{row.palletRemarks}</small>}</p></div>)}</div>
      {open&&<div className="result-options"><button disabled={busy||pdfBusy} onClick={()=>finish("completed")}>全部完成</button><button disabled={busy||pdfBusy} onClick={()=>finish("returned")}>退回备货位</button></div>}
    </>}
    {error&&<div className="login-error">! {error}</div>}
    <button className="pdf" disabled={busy||Boolean(busyPallet)||pdfBusy} onClick={printPdf}>▤ {pdfBusy?"正在准备打印…":"打印PDF作业单"}</button>
  </div></ModalFrame>;
}

function AccountsModal({users,currentUserId,close,api,done}:{users:User[];currentUserId:number;close:()=>void;api:ApiRequest;done:(m:string)=>void|Promise<void>}) {
  const [adding,setAdding]=useState(false);
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [newPermissions,setNewPermissions]=useState<PageKey[]>([]);
  const [editing,setEditing]=useState<User|null>(null);
  const [editingPermissions,setEditingPermissions]=useState<PageKey[]>([]);
  const [deleting,setDeleting]=useState<User|null>(null);
  const [deleteBusy,setDeleteBusy]=useState(false);
  const [error,setError]=useState("");
  const create=async(e:FormEvent)=>{
    e.preventDefault();setError("");
    try {
      await api("/api/v1/users",{method:"POST",body:JSON.stringify({username,password,pagePermissions:newPermissions})});
      setAdding(false);setUsername("");setPassword("");setNewPermissions([]);
      await done("内部账号已创建");
    } catch(err) {setError(err instanceof Error?err.message:"创建失败")}
  };
  const toggle=async(u:User)=>{
    setError("");
    try {await api(`/api/v1/users/${u.id}`,{method:"PATCH",body:JSON.stringify({active:!u.active})});await done(u.active?"账号已停用":"账号已启用")}
    catch(err){setError(err instanceof Error?err.message:"操作失败")}
  };
  const openPermissions=(u:User)=>{setError("");setEditing(u);setEditingPermissions(effectivePagePermissions(u.role,u.pagePermissions))};
  const savePermissions=async()=>{
    if(!editing||editing.role==="admin"){setEditing(null);return}
    setError("");
    try {
      await api(`/api/v1/users/${editing.id}`,{method:"PATCH",body:JSON.stringify({pagePermissions:editingPermissions})});
      setEditing(null);await done("账号权限已更新");
    } catch(err){setError(err instanceof Error?err.message:"权限保存失败")}
  };
  const remove=async()=>{
    if(!deleting||deleting.id===currentUserId)return;
    setError("");setDeleteBusy(true);
    try {
      await api(`/api/v1/users/${deleting.id}`,{method:"DELETE"});
      setDeleting(null);await done("账号已删除");
    } catch(err){setError(err instanceof Error?err.message:"删除失败")}
    finally{setDeleteBusy(false)}
  };
  if(editing) {
    const admin=editing.role==="admin";
    return <ModalFrame title={`权限设置 · ${editing.name}`} kicker="PAGE ACCESS" close={()=>setEditing(null)} wide><div className="permission-editor"><p>{admin?"系统管理员始终拥有全部页面权限，无法取消。":"仅勾选的页面会显示在对应主导航或“备货数据”页签中。"}</p><PermissionChecklist permissions={admin?ALL_PAGE_KEYS:editingPermissions} setPermissions={setEditingPermissions} disabled={admin}/>{error&&<div className="login-error">! {error}</div>}</div><div className="modal-actions"><button onClick={()=>setEditing(null)}>{admin?"关闭":"取消"}</button>{!admin&&<button className="primary" disabled={!editingPermissions.length} onClick={savePermissions}>保存权限</button>}</div></ModalFrame>;
  }
  if(deleting) {
    return <ModalFrame title={`删除账号 · ${deleting.name}`} kicker="CONFIRM DELETE" close={()=>{if(!deleteBusy){setDeleting(null);setError("")}}}><div className="account-delete-confirm"><strong>确定删除账号“{deleting.username}”吗？</strong><p>该账号将立即无法登录，所有已登录会话也会失效。仓库操作历史会保留原操作人信息。</p>{error&&<div className="login-error">! {error}</div>}</div><div className="modal-actions"><button disabled={deleteBusy} onClick={()=>{setDeleting(null);setError("")}}>取消</button><button className="account-delete-confirm-button" disabled={deleteBusy} onClick={remove}>{deleteBusy?"正在删除…":"确认删除"}</button></div></ModalFrame>;
  }
  return <ModalFrame title="账户管理" kicker="ADMIN ONLY" close={close} wide><div className="account-list"><p>管理员默认拥有全部权限。普通账号只会看到被授权的子页面；新增页面默认不授权，已删除页面的旧权限自动失效。</p>{users.map(u=>{
    const permissions=effectivePagePermissions(u.role,u.pagePermissions);
    return <div key={u.id} className={`account-row${!u.active?" disabled-user":""}`}><span>{u.name[0]}</span><div className="account-identity"><b>{u.name}</b><small>{u.username} · {u.email}</small></div>{u.role==="admin"&&<em>管理员</em>}<div className="account-actions"><button className="account-permission-button" onClick={()=>openPermissions(u)}><b>{u.role==="admin"?"全部权限":`已授权 ${permissions.length}/${PAGE_DEFINITIONS.length}`}</b><small>点击管理</small></button><button className="account-state-button" onClick={()=>toggle(u)}>{u.active?"停用":"启用"}</button>{u.id!==currentUserId&&<button className="account-delete-button" onClick={()=>{setError("");setDeleting(u)}}>删除</button>}</div></div>;
  })}{!adding?<button className="add-account" onClick={()=>{setAdding(true);setError("")}}>＋ 新增内部账号</button>:<form className="account-form account-create-form" onSubmit={create}><label>账号名称<input required value={username} onChange={e=>setUsername(e.target.value.toLowerCase())}/></label><label>初始密码<input required type="password" autoComplete="new-password" minLength={12} value={password} onChange={e=>setPassword(e.target.value)}/></label><fieldset className="permission-scope"><legend><span>权限范围</span><button type="button" onClick={()=>setNewPermissions(newPermissions.length===ALL_PAGE_KEYS.length?[]:[...ALL_PAGE_KEYS])}>{newPermissions.length===ALL_PAGE_KEYS.length?"取消全选":"全选"}</button></legend><PermissionChecklist permissions={newPermissions} setPermissions={setNewPermissions}/></fieldset>{error&&<div className="login-error">! {error}</div>}<div><button type="button" onClick={()=>{setAdding(false);setError("")}}>取消</button><button className="primary" disabled={!newPermissions.length}>创建账号</button></div></form>}</div></ModalFrame>;
}

function PermissionChecklist({permissions,setPermissions,disabled=false}:{permissions:readonly PageKey[];setPermissions:(permissions:PageKey[])=>void;disabled?:boolean}) {
  const selected=new Set(permissions);
  return <div className="permission-list" role="group" aria-label="子页面权限">{PAGE_DEFINITIONS.map(page=><label key={page.key}><span className="permission-page"><i>{page.icon}</i><span><b>{page.label}</b>{page.section==="warehouse-data"&&<small>备货数据页签</small>}{page.section==="timekeeping"&&<small>工时体系页面</small>}</span></span><input type="checkbox" checked={selected.has(page.key)} disabled={disabled} onChange={event=>setPermissions(event.target.checked?ALL_PAGE_KEYS.filter(key=>selected.has(key)||key===page.key):permissions.filter(key=>key!==page.key))}/></label>)}</div>;
}

function ModalFrame({title,kicker,close,children,wide=false}:{title:string;kicker:string;close:()=>void;children:React.ReactNode;wide?:boolean}) {
  return <div className="modal-backdrop" onMouseDown={e=>e.currentTarget===e.target&&close()}><div className={wide?"modal-card modal-card-wide":"modal-card"}><div className="modal-head"><div><span className="modal-kicker">{kicker}</span><h3>{title}</h3></div><button aria-label="关闭" onClick={close}>×</button></div>{children}</div></div>;
}
function Empty({text}:{text:string}){return <div className="empty-state"><span>□</span><p>{text}</p></div>}
function taskItemResult(task:Task):{key:"pending"|"completed"|"partial"|"returned"|"cancelled";label:string} {
  const outcome=task.itemOutcome??(["pending","claimed"].includes(task.status)?null:task.status);
  if(outcome==="completed") return {key:"completed",label:task.type==="pick"?"全部取出":task.type==="move"?"迁移完成":"存入完成"};
  if(outcome==="partial") return {key:"partial",label:task.type==="pick"?"部分取出":"部分完成"};
  if(outcome==="returned") return {key:"returned",label:"退回备货"};
  if(outcome==="cancelled") return {key:"cancelled",label:"已取消"};
  return {key:"pending",label:"待处理"};
}
function pickItemOutcome(task:Task):"completed"|"returned"|"partial"|null {
  return task.itemOutcome;
}
function formatTime(value:string){return formatWarehouseTime(value,{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})}
function formatLedgerTime(value:string){return formatWarehouseDateTimeFixed(value)}
function matchesWords(value:string,query:string){return query.toLowerCase().split(/\s+/).filter(Boolean).every(word=>value.toLowerCase().includes(word))}
function locationTypeLabel(type:"reserve"|"pick"){return type==="reserve"?"备货库位":"拣货库位"}
function formatMovementLocation(code:string|null,type:"reserve"|"pick"|null,fallback:string){return code?`${code}（${type==="pick"?"拣":"备"}）`:fallback}
function movementTouchesLocation(movement:Movement,location:Location) {
  return (movement.fromLocation===location.code&&movement.fromLocationType===location.type)
    ||(movement.toLocation===location.code&&movement.toLocationType===location.type);
}
function locationMovementDirection(movement:Movement,location:Location):{label:string;tone:"in"|"out"|"stay"} {
  const isFrom=movement.fromLocation===location.code&&movement.fromLocationType===location.type;
  const isTo=movement.toLocation===location.code&&movement.toLocationType===location.type;
  if(movement.action==="partial_pick"&&isFrom)return {label:"部分取出",tone:"stay"};
  if(movement.action==="partial_pick"&&isTo)return {label:"部分送达",tone:"in"};
  if(isFrom&&isTo)return {label:"原位记录",tone:"stay"};
  if(isTo)return {label:"移入",tone:"in"};
  return {label:"移出",tone:"out"};
}
function roleName(role:Role){return role==="admin"?"系统管理员":role==="manager"?"仓库主管":"操作员"}
function dateKey(value:string){return warehouseDateKey(value)}
function sortMovementsNewestFirst(rows:Movement[]){return [...rows].sort((a,b)=>parseStoredTimestamp(b.occurredAt).getTime()-parseStoredTimestamp(a.occurredAt).getTime()||b.id-a.id)}
function availableLocationSlots(location:Location){return Math.max(0,location.capacity-Number(location.palletCount??0))}
function reserveRowSelectionKey(row:ReserveRow){return row.pallet?.id??`EMPTY-${row.location.id}-${row.slotIndex}`}
function reserveRowStatus(row:ReserveRow):"in_stock"|"in_task"|"available" {
  if(row.pallet) return row.pallet.status;
  return "available";
}
function reserveStatusLabel(status:"in_stock"|"in_task"|"available"){return status==="in_stock"?"在库":status==="in_task"?"作业中":"空库位"}
function sortValue(row:ReserveRow,key:SortKey):string|number {
  if(key==="location")return row.location.code;
  if(key==="sku")return row.pallet?.sku??"";
  if(key==="inboundAt")return row.pallet?.inboundAt??"";
  if(key==="ageDays")return Number(row.pallet?.ageDays??-1);
  return reserveRowStatus(row);
}

function parseExactSkuList(value:string) {
  return new Set(value.split(/[,，;；\r\n]+/).map(item=>item.trim().toUpperCase()).filter(Boolean));
}

async function downloadReserveStatisticsWorkbook(rows:Array<{sku:string;palletCount:number}>) {
  const values=[
    ["排名","SKU","备货托数"],
    ...rows.map((row,index)=>[index+1,row.sku,row.palletCount]),
  ];
  await downloadWorksheet({
    rows:values,sheetName:"备货统计",fileName:`内库备货统计-${dateKey(new Date().toISOString())}.xlsx`,
    widths:[10,30,14],autoFilter:`A1:C${values.length}`,
  });
}

async function downloadLocationImportWorkbook(locations:Location[]) {
  const rows=[...locations].sort((a,b)=>a.type.localeCompare(b.type)||a.code.localeCompare(b.code,"zh-CN",{numeric:true}));
  const values:Array<Array<string|number>>=[
    [...LOCATION_IMPORT_HEADERS],
    ...rows.map(location=>[location.code,locationTypeLabel(location.type),location.capacity]),
  ];
  await downloadWorksheet({
    rows:values,sheetName:"库位",fileName:`内库全部库位-${dateKey(new Date().toISOString())}.xlsx`,
    widths:[22,16,12],autoFilter:`A1:C${values.length}`,
  });
}

async function downloadWarehouseLedgerWorkbook(movementRows:Movement[],palletRows:Pallet[],locationRows:Location[]) {
  if(!movementRows.length)throw new Error("当前没有可导出的操作历史");
  const ordered=sortMovementsNewestFirst(movementRows);
  const historyValues:Array<Array<string|number>>=[
    [...WAREHOUSE_LEDGER_HEADERS],
    ...ordered.map(movement=>[
      movement.sourceId??movement.id,formatWarehouseDateTimeFixed(movement.occurredAt),actionLabel[movement.action],movement.sku,movement.palletId,
      movement.fromLocation??"",movement.fromLocationType?locationTypeLabel(movement.fromLocationType):"",
      movement.toLocation??"",movement.toLocationType?locationTypeLabel(movement.toLocationType):"",
      movement.remarks?.trim()??"",movement.taskId??"",movement.operatorUsername??"",movement.operator??"",
    ]),
  ];

  const skuCodes=Array.from(new Set([...palletRows.map(pallet=>pallet.sku),...movementRows.map(movement=>movement.sku)]))
    .sort((a,b)=>a.localeCompare(b,"zh-CN",{numeric:true}));
  const skuValues:Array<Array<string|number>>=[
    ["SKU","当前托盘数","当前库位","历史操作数","最后操作时间（美东）"],
    ...skuCodes.map(sku=>{
      const current=palletRows.filter(pallet=>pallet.sku===sku);
      const events=ordered.filter(movement=>movement.sku===sku);
      return [sku,current.length,Array.from(new Set(current.map(pallet=>pallet.location).filter(Boolean))).join("、"),events.length,events[0]?formatWarehouseDateTimeFixed(events[0].occurredAt):""];
    }),
  ];

  const sortedLocations=[...locationRows].sort((a,b)=>a.type.localeCompare(b.type)||a.code.localeCompare(b.code,"zh-CN",{numeric:true}));
  const locationValues:Array<Array<string|number>>=[
    ["库位","类型","区域","容量","当前占用","当前SKU","移入记录","移出记录","最后操作时间（美东）"],
    ...sortedLocations.map(location=>{
      const current=palletRows.filter(pallet=>pallet.locationId===location.id);
      const events=ordered.filter(movement=>movementTouchesLocation(movement,location));
      const inbound=events.filter(movement=>movement.toLocation===location.code&&movement.toLocationType===location.type&&!(movement.fromLocation===location.code&&movement.fromLocationType===location.type)).length;
      const outbound=events.filter(movement=>movement.fromLocation===location.code&&movement.fromLocationType===location.type&&!(movement.toLocation===location.code&&movement.toLocationType===location.type)).length;
      return [location.code,locationTypeLabel(location.type),location.zone,location.capacity,current.length,Array.from(new Set(current.map(pallet=>pallet.sku))).join("、"),inbound,outbound,events[0]?formatWarehouseDateTimeFixed(events[0].occurredAt):""];
    }),
  ];

  await downloadWorkbook({
    fileName:`内库仓库台账-${dateKey(new Date().toISOString())}.xlsx`,
    sheets:[
      {sheetName:WAREHOUSE_LEDGER_HISTORY_SHEET,rows:historyValues,widths:[10,22,15,26,24,18,16,18,16,36,22,18,18],autoFilter:`A1:M${historyValues.length}`},
      {sheetName:"SKU汇总",rows:skuValues,widths:[28,14,52,14,22],autoFilter:`A1:E${skuValues.length}`},
      {sheetName:"库位汇总",rows:locationValues,widths:[20,16,12,10,12,44,12,12,22],autoFilter:`A1:I${locationValues.length}`},
    ],
  });
}

async function downloadReserveWorkbook(rows:ReserveRow[]) {
  const values=[
    [...RESERVE_INVENTORY_HEADERS],
    ...rows.map(row=>[row.location.code,`${row.slotIndex}/${row.location.capacity}`,row.pallet?.sku??"",row.pallet?.id??"",row.pallet?.remarks??"",row.pallet?formatWarehouseDateTimeFixed(row.pallet.inboundAt):"",row.pallet?.ageDays??"",reserveStatusLabel(reserveRowStatus(row))]),
  ];
  await downloadWorksheet({
    rows:values,sheetName:RESERVE_INVENTORY_SHEET,fileName:`内库备库总表-${dateKey(new Date().toISOString())}.xlsx`,
    widths:[14,14,14,30,36,22,12,16],autoFilter:`A1:H${values.length}`,
  });
}
