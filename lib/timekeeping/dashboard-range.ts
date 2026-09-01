import { addDays, localDateTimeToIso, workDate } from "./time";

export function dashboardRangeBounds(requestedStartDate?:string|null,requestedEndDate?:string|null){
  const fallback=workDate();
  let startDate=validDate(requestedStartDate)?requestedStartDate:fallback;
  let endDate=validDate(requestedEndDate)?requestedEndDate:fallback;
  if(startDate>endDate)[startDate,endDate]=[endDate,startDate];
  return {
    id:"custom" as const,
    label:dashboardRangeLabel(startDate,endDate),
    startDate,
    endDate,
    start:localDateTimeToIso(`${startDate}T00:00`),
    end:localDateTimeToIso(`${addDays(endDate,1)}T00:00`),
  };
}

export function dashboardRangeLabel(startDate:string,endDate:string){
  const display=(value:string)=>value.replaceAll("-","/");
  return startDate===endDate?display(startDate):`${display(startDate)}–${display(endDate)}`;
}

function validDate(value:unknown):value is string{
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
