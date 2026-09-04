export const TIMEKEEPING_TIME_ZONE="America/New_York";

export function workDate(value:string|Date=new Date()){
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:TIMEKEEPING_TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
  }).formatToParts(value instanceof Date?value:new Date(value));
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value??"";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function localDateTimeToIso(value:string){
  const normalized=value.trim();
  if(!normalized)throw new Error("时间不能为空");
  if(/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)){
    const parsed=new Date(normalized);
    if(Number.isNaN(parsed.getTime()))throw new Error("时间格式无效");
    return parsed.toISOString();
  }
  const match=normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!match)throw new Error("时间格式无效");
  const target={year:Number(match[1]),month:Number(match[2]),day:Number(match[3]),hour:Number(match[4]),minute:Number(match[5]),second:Number(match[6]??0)};
  const targetAsUtc=Date.UTC(target.year,target.month-1,target.day,target.hour,target.minute,target.second);
  let candidate=targetAsUtc;
  for(let iteration=0;iteration<4;iteration++){
    const rendered=timekeepingParts(new Date(candidate));
    candidate+=targetAsUtc-Date.UTC(rendered.year,rendered.month-1,rendered.day,rendered.hour,rendered.minute,rendered.second);
  }
  const roundTrip=timekeepingParts(new Date(candidate));
  if(Object.entries(target).some(([key,entry])=>roundTrip[key as keyof typeof roundTrip]!==entry)){
    throw new Error("该美东时间不存在或处于夏令时切换区间");
  }
  return new Date(candidate).toISOString();
}

export function addDays(date:string,amount:number){const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+amount);return value.toISOString().slice(0,10)}
export function monthRange(period:string|undefined,today=workDate()){const requested=/^\d{4}-\d{2}$/.test(period??"")?period!:today.slice(0,7);const [year,month]=requested.split("-").map(Number);const startDate=`${requested}-01`;const next=new Date(Date.UTC(year,month,1,12));const nextId=next.toISOString().slice(0,7);const end=new Date(Date.UTC(year,month,0,12));const previous=new Date(Date.UTC(year,month-2,1,12)).toISOString().slice(0,7);return {id:requested,label:`${year}年${String(month).padStart(2,"0")}月`,startDate,endDate:end.toISOString().slice(0,10),previous,next:nextId}}
export type AttendanceExportScope="month"|"first-half"|"second-half";
export function attendanceExportRange(period:string,scope:AttendanceExportScope){
  const month=monthRange(period);
  if(scope==="first-half")return {...month,scope,label:`${month.label}上半月`,endDate:`${month.id}-15`};
  if(scope==="second-half")return {...month,scope,label:`${month.label}下半月`,startDate:`${month.id}-16`};
  return {...month,scope,label:month.label};
}
export function durationMs(start:string|Date,end:string|Date){return Math.max(0,new Date(end).getTime()-new Date(start).getTime())}

function timekeepingParts(value:Date){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:TIMEKEEPING_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,hourCycle:"h23"}).formatToParts(value);
  const part=(type:Intl.DateTimeFormatPartTypes)=>Number(parts.find(item=>item.type===type)?.value??0);
  return {year:part("year"),month:part("month"),day:part("day"),hour:part("hour"),minute:part("minute"),second:part("second")};
}
