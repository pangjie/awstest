import { addDays, localDateTimeToIso, workDate } from "./timekeeping/time";

export class ExportError extends Error {
  quota?:{siteRemaining:number;resetAt:string};
  constructor(public status:number, public code:string, message:string, public retryAfter?:number) { super(message); }
}
export const EXPORT_LIMITS={rows:20_000,bytes:20*1024*1024,siteDaily:100,minute:6} as const;
export function parseExportQuery(params:URLSearchParams) {
  const allowed=["date"];
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw new ExportError(400,"INVALID_PARAMETER","Unknown or repeated parameter");
  const date=params.get("date")??"";
  const valid=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>="2000-01-01"&&value<="9998-12-31"&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!valid(date))throw new ExportError(400,"INVALID_DATE","A valid date in YYYY-MM-DD format is required");
  return {date,start:localDateTimeToIso(`${date}T00:00`),end:localDateTimeToIso(`${addDays(date,1)}T00:00`)};
}
export type ExportQuery=ReturnType<typeof parseExportQuery>;
export function quotaWindow(now=new Date()) {
  const day=workDate(now),reset=localDateTimeToIso(`${addDays(day,1)}T00:00`);
  return {day,reset,retryAfter:Math.max(1,Math.ceil((Date.parse(reset)-now.getTime())/1000))};
}
