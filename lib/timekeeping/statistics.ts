import { addDays, localDateTimeToIso, workDate } from "./time";

export type StatsEmployee={id:number;name:string;organization:string;active:boolean};
export type StatsShift={id:number;employeeId:number;date:string;start:string;end:string|null;modified:boolean};
export type StatsSession={id:number;employeeId:number;shiftId:number;itemId:number;start:string;end:string|null;modified:boolean};
export type StatsItem={id:number;name:string;code:string;kind:"wave"|"standard";waveNo:string|null;channel:string;type:string;status:string;createdAt:string;completedAt:string|null;orders:number;pieces:number};
export type StatsInput={startDate:string;endDate:string;generatedAt:string;snapshotAt?:string;employees:StatsEmployee[];shifts:StatsShift[];sessions:StatsSession[];items:StatsItem[]};
export type StatsPage=StatsInput&{ok:true;revision:string;next:string|null};
export type StatsIssue={employeeId:number|null;date:string;task:string;message:string};
export type StatsFragment={employeeId:number;date:string;project:string;itemId:number|null;waveNo:string;start:string;end:string;ms:number;modified:boolean;standby:boolean};
export type StatsPerson=StatsEmployee&{days:number;onDutyMs:number;workMs:number;standbyMs:number;projects:Record<string,number>;waveMs:number;pieces:number;waves:number;efficiency:number|null;issues:number};
export type StatsType={name:string;waves:number;orders:number;pieces:number;pickMs:number;scanMs:number;pickRate:number|null;scanRate:number|null;combinedRate:number|null;incomplete:boolean};
export type StatsAllocation={employeeId:number;date:string;waveNo:string;type:string;ms:number;share:number;pieces:number;efficiency:number|null};
export const STATS_MAX_RECORDS=50_000;

export function statisticsRange(startDate:string,endDate:string,today=workDate()){
  const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&s>="2000-01-01"&&s<="9998-12-31"&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  if(!valid(startDate)||!valid(endDate)||startDate>endDate)throw new Error("请选择有效的起止日期");
  if(endDate>today)throw new Error("不可统计未来日期");
  const d=new Date(`${startDate}T12:00:00Z`),day=d.getUTCDate();
  d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+3);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,last));
  if(endDate>=d.toISOString().slice(0,10))throw new Error("单次查询最多三个自然月");
  return {startDate,endDate,start:localDateTimeToIso(`${startDate}T00:00`),end:localDateTimeToIso(`${addDays(endDate,1)}T00:00`)};
}

type Interval=[number,number];
function union(intervals:Interval[]):Interval[]{
  const result:Interval[]=[];
  for(const [start,end] of intervals.toSorted((a,b)=>a[0]-b[0])){
    const last=result.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
  }
  return result;
}
const length=(intervals:Interval[])=>intervals.reduce((n,[s,e])=>n+e-s,0);
const rate=(pieces:number,ms:number)=>ms>0?pieces*3_600_000/ms:null;
const iso=(n:number)=>new Date(n).toISOString();
export function computeStatistics(input:StatsInput){
  if(input.snapshotAt&&!Number.isFinite(Date.parse(input.snapshotAt)))throw new Error("统计截止时间无效");
  const snapshotDate=input.snapshotAt?workDate(input.snapshotAt):null;
  const range=statisticsRange(input.startDate,input.endDate,snapshotDate??workDate());
  const lo=Date.parse(range.start),hi=Math.min(Date.parse(range.end),input.snapshotAt?Date.parse(input.snapshotAt):Infinity);
  const isSnapshot=input.endDate===snapshotDate;
  const items=new Map(input.items.map(x=>[x.id,x]));
  const employees=new Map(input.employees.map(x=>[x.id,x]));
  const shifts=new Map(input.shifts.map(x=>[x.id,x]));
  const issues:StatsIssue[]=[],fragments:StatsFragment[]=[],allocations:StatsAllocation[]=[];
  const issue=(employeeId:number|null,date:string,task:string,message:string)=>issues.push({employeeId,date,task,message});
  const shiftIntervals=new Map<number,Interval>();
  const uncertainDays=new Set<string>(),badItems=new Set<number>();
  const days=new Map<string,{employeeId:number;date:string;attendance:Interval[];work:Interval[];sessions:Array<{interval:Interval;session:StatsSession;item:StatsItem;modified:boolean}>}>();
  const getDay=(employeeId:number,date:string)=>{
    const key=`${employeeId}:${date}`;
    if(!days.has(key))days.set(key,{employeeId,date,attendance:[],work:[],sessions:[]});
    return days.get(key)!;
  };
  for(const shift of input.shifts){
    if(shift.date<input.startDate||shift.date>input.endDate)continue;
    getDay(shift.employeeId,shift.date);
    if(!employees.has(shift.employeeId)){issue(shift.employeeId,shift.date,"考勤","员工资料缺失");continue}
    if(Date.parse(shift.start)>=hi)continue;
    if(!shift.end&&shift.date!==snapshotDate){issue(shift.employeeId,shift.date,"考勤","历史考勤未结束，未推算结束时间");continue}
    const start=Math.max(Date.parse(shift.start),lo),end=Math.min(shift.end?Date.parse(shift.end):hi,hi);
    if(!Number.isFinite(start+end)||end<=start){issue(shift.employeeId,shift.date,"考勤","考勤时间无效");continue}
    shiftIntervals.set(shift.id,[start,end]);getDay(shift.employeeId,shift.date).attendance.push([start,end]);
  }
  for(const session of input.sessions){
    const shift=shifts.get(session.shiftId),item=items.get(session.itemId);
    const date=shift?.date??input.startDate;
    if(!shift||shift.employeeId!==session.employeeId||!item){issue(session.employeeId,date,item?.name??"任务","关联记录缺失或不匹配");uncertainDays.add(`${session.employeeId}:${date}`);badItems.add(session.itemId);continue}
    const bounds=shiftIntervals.get(shift.id);
    if(Date.parse(session.start)>=hi)continue;
    if(!session.end&&(date!==snapshotDate||shift.end!==null)){issue(session.employeeId,date,item.name,"历史任务未结束，未推算结束时间");uncertainDays.add(`${session.employeeId}:${date}`);badItems.add(item.id);continue}
    if(!bounds){badItems.add(item.id);continue}
    const rawStart=Date.parse(session.start),rawEnd=session.end?Date.parse(session.end):hi;
    if(!Number.isFinite(rawStart+rawEnd)||rawEnd<=rawStart){issue(session.employeeId,date,item.name,"任务时间无效");uncertainDays.add(`${session.employeeId}:${date}`);badItems.add(item.id);continue}
    const start=Math.max(rawStart,bounds[0]),end=Math.min(rawEnd,bounds[1]);
    if(rawStart<bounds[0]||Math.min(rawEnd,hi)>bounds[1]){issue(session.employeeId,date,item.name,"任务超出考勤区间，已按交集统计");badItems.add(item.id)}
    if(end<=start)continue;
    getDay(session.employeeId,date).sessions.push({interval:[start,end],session,item,modified:session.modified||shift.modified});
  }
  const daily:Array<{employeeId:number;date:string;onDutyMs:number;workMs:number;standbyMs:number;projects:Record<string,number>;pieces:number;waveMs:number;efficiency:number|null}>=[];
  const projectNames=new Set<string>(["波次拣货","单件扫描","混件扫描","问题单","仓务","清洁"]);
  for(const item of input.items)if(item.kind==="standard")projectNames.add(item.name);
  for(const day of days.values()){
    const attendance=union(day.attendance);
    if(length(attendance)<length(day.attendance))issue(day.employeeId,day.date,"考勤","考勤重叠，在岗时间已去重");
    const ordered=day.sessions.toSorted((a,b)=>a.interval[0]-b.interval[0]);
    // Ambiguous overlapping task segments are excluded as a group, never assigned arbitrarily.
    const invalid=new Set<number>();let group:number[]=[],end=-Infinity;
    for(const [i,s] of ordered.entries()){
      if(s.interval[0]<end){for(const j of group)invalid.add(j);invalid.add(i);group.push(i);end=Math.max(end,s.interval[1])}
      else{group=[i];end=s.interval[1]}
    }
    if(invalid.size)issue(day.employeeId,day.date,"任务","任务计时重叠，冲突片段不计入项目用时；覆盖时间不算待命");
    const projects:Record<string,number>={};
    for(const [i,s] of ordered.entries()){
      day.work.push(s.interval);
      if(invalid.has(i)){badItems.add(s.item.id);continue}
      const project=s.item.kind==="wave"?"波次拣货":s.item.name;
      projectNames.add(project);
      const ms=s.interval[1]-s.interval[0];projects[project]=(projects[project]??0)+ms;
      fragments.push({employeeId:day.employeeId,date:day.date,project,itemId:s.item.id,waveNo:s.item.waveNo??"",start:iso(s.interval[0]),end:iso(s.interval[1]),ms,modified:s.modified,standby:false});
    }
    const covered=union(day.work);
    const uncertain=uncertainDays.has(`${day.employeeId}:${day.date}`);
    for(const [start,end] of uncertain?[]:attendance){
      let cursor=start;
      for(const [a,b] of covered){
        if(b<=cursor||a>=end)continue;
        if(a>cursor)fragments.push({employeeId:day.employeeId,date:day.date,project:"在岗待命",itemId:null,waveNo:"",start:iso(cursor),end:iso(a),ms:a-cursor,modified:false,standby:true});
        cursor=Math.max(cursor,b);
      }
      if(cursor<end)fragments.push({employeeId:day.employeeId,date:day.date,project:"在岗待命",itemId:null,waveNo:"",start:iso(cursor),end:iso(end),ms:end-cursor,modified:false,standby:true});
    }
    daily.push({employeeId:day.employeeId,date:day.date,onDutyMs:length(attendance),workMs:Object.values(projects).reduce((a,b)=>a+b,0),standbyMs:uncertain?0:length(attendance)-length(covered),projects,pieces:0,waveMs:0,efficiency:null});
  }
  const types=new Map<string,StatsType>(["爆品","单件","多件","混件","未标注"].map(name=>[name,{name,waves:0,orders:0,pieces:0,pickMs:0,scanMs:0,pickRate:null,scanRate:null,combinedRate:null,incomplete:false}]));
  const waveFragments=new Map<number,StatsFragment[]>();
  for(const f of fragments)if(f.itemId!==null&&items.get(f.itemId)?.kind==="wave"){
    if(!waveFragments.has(f.itemId))waveFragments.set(f.itemId,[]);waveFragments.get(f.itemId)!.push(f);
  }
  for(const item of input.items){
    if(item.kind!=="wave")continue;
    if(Date.parse(item.createdAt)>=hi)continue;
    const date=workDate(item.createdAt),parts=waveFragments.get(item.id)??[];
    if(date<input.startDate||date>input.endDate){if(parts.length)issue(null,date,item.waveNo??item.name,"跨日期波次不符合统计口径");continue}
    if(item.status!=="completed"||!item.completedAt||Date.parse(item.completedAt)>hi){if(date!==snapshotDate)issue(null,date,item.waveNo??item.name,"历史波次未完结，不计入完成产量与时效");continue}
    if(workDate(item.completedAt)!==date){issue(null,date,item.waveNo??item.name,"波次跨日完结，不计入完成产量与时效");continue}
    const type=types.get(item.type)||types.get("未标注")!;
    type.waves++;type.orders+=item.orders;type.pieces+=item.pieces;
    const ms=parts.reduce((sum,p)=>sum+p.ms,0);type.pickMs+=ms;
    const bad=badItems.has(item.id)||parts.some(p=>issues.some(e=>e.employeeId===p.employeeId&&e.date===p.date));
    if(ms<=0||bad){type.incomplete=true;issue(null,date,item.waveNo??item.name,"波次工时缺失或存在异常，折算件数与时效待核对");continue}
    const byEmployee=new Map<number,number>();
    for(const p of parts)byEmployee.set(p.employeeId,(byEmployee.get(p.employeeId)??0)+p.ms);
    for(const [employeeId,duration] of byEmployee){
      const pieces=item.pieces*duration/ms;
      allocations.push({employeeId,date,waveNo:item.waveNo??item.code,type:type.name,ms:duration,share:duration/ms,pieces,efficiency:rate(pieces,duration)});
      const d=daily.find(d=>d.employeeId===employeeId&&d.date===date);
      if(d){d.pieces+=pieces;d.waveMs+=duration;d.efficiency=rate(d.pieces,d.waveMs)}
    }
  }
  const scanMs=(code:string)=>fragments.filter(f=>f.itemId!==null&&items.get(f.itemId)?.code===code).reduce((n,f)=>n+f.ms,0);
  types.get("单件")!.scanMs=scanMs("SINGLE-SCAN");types.get("混件")!.scanMs=scanMs("SCAN");
  for(const type of types.values()){
    const scanned=type.name==="单件"||type.name==="混件";
    const scanCode=type.name==="单件"?"SINGLE-SCAN":"SCAN";
    const scanInvalid=scanned&&input.items.some(i=>i.code===scanCode&&badItems.has(i.id));
    type.pickRate=type.incomplete?null:rate(type.pieces,type.pickMs);
    type.scanRate=scanned&&!scanInvalid?rate(type.pieces,type.scanMs):null;
    type.combinedRate=type.incomplete||scanInvalid||(scanned&&type.pieces>0&&type.scanMs===0)?null:rate(type.pieces,type.pickMs+type.scanMs);
  }
  const people:StatsPerson[]=input.employees.map(e=>{
    const rows=daily.filter(d=>d.employeeId===e.id),projects:Record<string,number>={};
    for(const d of rows)for(const [p,ms] of Object.entries(d.projects))projects[p]=(projects[p]??0)+ms;
    const assigned=allocations.filter(a=>a.employeeId===e.id),pieces=assigned.reduce((n,a)=>n+a.pieces,0),waveMs=assigned.reduce((n,a)=>n+a.ms,0);
    return {...e,days:rows.filter(d=>d.onDutyMs>0).length,onDutyMs:rows.reduce((n,d)=>n+d.onDutyMs,0),workMs:rows.reduce((n,d)=>n+d.workMs,0),standbyMs:rows.reduce((n,d)=>n+d.standbyMs,0),projects,pieces,waveMs,waves:assigned.length,efficiency:rate(pieces,waveMs),issues:issues.filter(i=>i.employeeId===e.id).length};
  }).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")||a.id-b.id);
  const projects=[...projectNames,"在岗待命"].map(name=>{
    const rows=fragments.filter(f=>f.project===name),ms=rows.reduce((n,f)=>n+f.ms,0),count=new Set(rows.map(f=>f.employeeId)).size;
    return {name,ms,count,averageMs:count?ms/count:0};
  });
  for(const person of people)if(person.issues)person.efficiency=null;
  for(const day of daily)if(issues.some(i=>i.employeeId===day.employeeId&&i.date===day.date))day.efficiency=null;
  const totalTypes=[...types.values()],pieces=totalTypes.reduce((n,t)=>n+t.pieces,0),pickMs=totalTypes.reduce((n,t)=>n+t.pickMs,0),scanningMs=totalTypes.reduce((n,t)=>n+t.scanMs,0);
  const totals={calendarDays:(Date.parse(input.endDate)-Date.parse(input.startDate))/86400000+1,workDays:new Set(daily.filter(d=>d.onDutyMs>0).map(d=>d.date)).size,people:people.filter(e=>e.days>0).length,personDays:people.reduce((n,e)=>n+e.days,0),waves:totalTypes.reduce((n,t)=>n+t.waves,0),orders:totalTypes.reduce((n,t)=>n+t.orders,0),pieces,overallEfficiency:rate(pieces,people.reduce((n,e)=>n+e.onDutyMs,0)),onDutyMs:people.reduce((n,e)=>n+e.onDutyMs,0),workMs:people.reduce((n,e)=>n+e.workMs,0),standbyMs:people.reduce((n,e)=>n+e.standbyMs,0),pickRate:totalTypes.some(t=>t.incomplete)?null:rate(pieces,pickMs),combinedRate:totalTypes.some(t=>t.pieces>0&&t.combinedRate===null)?null:rate(pieces,pickMs+scanningMs)};
  return {startDate:input.startDate,endDate:input.endDate,generatedAt:input.generatedAt,snapshotAt:input.snapshotAt,isSnapshot,people,types:totalTypes,projects,projectNames:[...projectNames],daily,allocations,fragments,issues,totals};
}
export type StatisticsResult=ReturnType<typeof computeStatistics>;
