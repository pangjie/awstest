import { addDays, localDateTimeToIso } from "./time";

export const DASHBOARD_RANGES=[
  {id:"1d",days:1},
  {id:"3d",days:3},
  {id:"7d",days:7},
  {id:"14d",days:14},
  {id:"30d",days:30},
] as const;

export type DashboardRangeId=(typeof DASHBOARD_RANGES)[number]["id"];

export function normalizeDashboardRange(value:unknown):DashboardRangeId{
  return DASHBOARD_RANGES.some(range=>range.id===value)?value as DashboardRangeId:"1d";
}

export function dashboardRangeBounds(date:string,rangeId:DashboardRangeId){
  const range=DASHBOARD_RANGES.find(item=>item.id===rangeId)??DASHBOARD_RANGES[0];
  const startDate=addDays(date,1-range.days);
  const label=dashboardRangeLabel(date,range.id);
  return {
    id:range.id,
    label,
    startDate,
    endDate:date,
    start:localDateTimeToIso(`${startDate}T00:00`),
    end:localDateTimeToIso(`${addDays(date,1)}T00:00`),
  };
}

export function dashboardRangeLabel(date:string,rangeId:DashboardRangeId){
  const range=DASHBOARD_RANGES.find(item=>item.id===rangeId)??DASHBOARD_RANGES[0];
  const startDate=addDays(date,1-range.days);
  const display=(value:string)=>value.replaceAll("-","/");
  return range.days===1?display(date):`${display(startDate)}–${display(date)}`;
}
