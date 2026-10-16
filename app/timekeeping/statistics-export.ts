import type { StatisticsResult } from "@/lib/timekeeping/statistics";

type Sheet={sheetName:string;rows:Array<Array<string|number>>;widths:number[];numberFormats:Record<number,string>;cellFormats?:Record<string,string>};
export function statisticsSheets(r:StatisticsResult):Sheet[]{
  const name=(id:number)=>r.people.find(p=>p.id===id)?.name??"员工资料缺失";
  const duration=(ms:number)=>ms/86_400_000,number=(n:number|null)=>n??"";
  const sheet=(sheetName:string,headers:string[],rows:Array<Array<string|number>>,durations:number[]=[]):Sheet=>({sheetName,rows:[headers,...rows],widths:headers.map(h=>h.includes("时间")?28:18),numberFormats:Object.fromEntries(durations.map(c=>[c,"[h]:mm"]))});
  const t=r.totals;
  const overview=sheet("总体统计",["统计项","数值"],[["自然日数",t.calendarDays],["实际工作日",t.workDays],["出勤人天",t.personDays],["完成波次数",t.waves],["订单数",t.orders],["件数",t.pieces],["在岗时长",duration(t.onDutyMs)],["工作时长",duration(t.workMs)],["在岗待命",duration(t.standbyMs)],["总体拣货效率",number(t.overallEfficiency)],["工作时间占比",t.onDutyMs?t.workMs/t.onDutyMs:""]]);
  overview.cellFormats={B8:"[h]:mm",B9:"[h]:mm",B10:"[h]:mm",B11:"0.##",B12:"0.0%"};
  const types=sheet("波次类型汇总",["类型","波次数","订单数","件数","拣货用时","扫描用时","拣货时效","扫描时效","综合时效"],r.types.map(t=>[t.name,t.waves,t.orders,t.pieces,duration(t.pickMs),duration(t.scanMs),number(t.pickRate),number(t.scanRate),number(t.combinedRate)]),[5,6]);
  const projects=sheet("项目工时",["项目","总用时","参与人次","工时占比"],r.projects.map(p=>[p.name,duration(p.ms),p.count,t.onDutyMs?p.ms/t.onDutyMs:""]),[2]);projects.numberFormats[4]="0.0%";
  const employees=sheet("员工汇总",["姓名","出勤天数",...r.projectNames,"在岗待命","工作合计","工作时间占比"],r.people.filter(p=>p.days||p.issues||p.workMs).map(p=>[p.name,p.days,...r.projectNames.map(n=>duration(p.projects[n]??0)),duration(p.standbyMs),duration(p.workMs),p.onDutyMs?p.workMs/p.onDutyMs:""]),[...r.projectNames.map((_,i)=>i+3),r.projectNames.length+3,r.projectNames.length+4]);employees.numberFormats[r.projectNames.length+5]="0.0%";
  const daily=sheet("每日汇总",["日期","姓名",...r.projectNames,"在岗待命","工作时长"],r.daily.map(d=>[d.date,name(d.employeeId),...r.projectNames.map(p=>duration(d.projects[p]??0)),duration(d.standbyMs),duration(d.workMs)]),[...r.projectNames.map((_,i)=>i+3),r.projectNames.length+3,r.projectNames.length+4]);
  const issues=sheet("异常记录",["日期","姓名","任务","说明"],r.issues.map(i=>[i.date,i.employeeId===null?"":name(i.employeeId),i.task,i.message]));
  for(const column of [7,8,9])types.numberFormats[column]="0.##";
  // Keep the snapshot context in the file even though the page hides this metadata.
  const info=sheet("导出信息",["项目","数值"],[["起始日期",r.startDate],["终止日期",r.endDate],["统计截至 UTC",r.snapshotAt??r.generatedAt],["统计状态",r.isSnapshot?"包含当日快照，时效暂估":"历史统计"],["数据核对",r.issues.length?"存在异常，统计仅包含可确认的有效记录":"无异常"],["导出范围","查询时段内所有有记录员工，包含各员工每日汇总"],["时间格式","用时为小时:分钟，保留可求和的精确数值"]]);
  return [overview,projects,types,employees,daily,...(r.issues.length?[issues]:[]),info];
}
