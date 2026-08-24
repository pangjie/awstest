export const WAREHOUSE_TIME_ZONE = "America/New_York";

const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;

export function normalizeStoredTimestamp(value:string) {
  const normalized=value.trim();
  if(SQLITE_UTC_TIMESTAMP.test(normalized)) return `${normalized.replace(" ","T")}Z`;
  return normalized;
}

export function parseStoredTimestamp(value:string|Date) {
  return value instanceof Date?value:new Date(normalizeStoredTimestamp(value));
}

export function warehouseDateKey(value:string|Date) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:WAREHOUSE_TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
  }).formatToParts(parseStoredTimestamp(value));
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value??"";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function previousWarehouseDateKey(value:string|Date) {
  const [year,month,day]=warehouseDateKey(value).split("-").map(Number);
  const previous=new Date(Date.UTC(year,month-1,day-1,12));
  return `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth()+1)}-${pad(previous.getUTCDate())}`;
}

export function formatWarehouseTime(value:string|Date,options:Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("zh-CN",{
    ...options,
    timeZone:WAREHOUSE_TIME_ZONE,
  }).format(parseStoredTimestamp(value));
}

export function formatWarehouseDateTimeFixed(value:string|Date) {
  const parts=warehouseParts(parseStoredTimestamp(value));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function toWarehouseDateTimeInput(value:string|Date) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:WAREHOUSE_TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit",
    hour12:false,
    hourCycle:"h23",
  }).formatToParts(parseStoredTimestamp(value));
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value??"";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function warehouseDateTimeInputToIso(value:string) {
  const normalized=value.trim();
  if(!normalized) throw new Error("时间不能为空");
  if(EXPLICIT_TIME_ZONE.test(normalized)||SQLITE_UTC_TIMESTAMP.test(normalized)) {
    const parsed=parseStoredTimestamp(normalized);
    if(Number.isNaN(parsed.getTime())) throw new Error("时间格式无效");
    return parsed.toISOString();
  }
  const match=normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!match) throw new Error("时间格式无效");
  const target={
    year:Number(match[1]),
    month:Number(match[2]),
    day:Number(match[3]),
    hour:Number(match[4]),
    minute:Number(match[5]),
    second:Number(match[6]??0),
  };
  const targetAsUtc=Date.UTC(target.year,target.month-1,target.day,target.hour,target.minute,target.second);
  let candidate=targetAsUtc;
  for(let iteration=0;iteration<4;iteration++) {
    const rendered=warehouseParts(new Date(candidate));
    const renderedAsUtc=Date.UTC(rendered.year,rendered.month-1,rendered.day,rendered.hour,rendered.minute,rendered.second);
    candidate+=targetAsUtc-renderedAsUtc;
  }
  const roundTrip=warehouseParts(new Date(candidate));
  if(Object.entries(target).some(([key,value])=>roundTrip[key as keyof typeof roundTrip]!==value)) {
    throw new Error("该美东时间不存在或处于夏令时切换区间");
  }
  return new Date(candidate).toISOString();
}

function warehouseParts(value:Date) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:WAREHOUSE_TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false,
    hourCycle:"h23",
  }).formatToParts(value);
  const part=(type:Intl.DateTimeFormatPartTypes)=>Number(parts.find(item=>item.type===type)?.value??0);
  return {
    year:part("year"),
    month:part("month"),
    day:part("day"),
    hour:part("hour"),
    minute:part("minute"),
    second:part("second"),
  };
}

function pad(value:number) {
  return String(value).padStart(2,"0");
}
