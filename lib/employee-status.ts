export type EmployeeStatus="picking"|"warehouse"|"ready"|"off"|"not_started";
export type StatusEmployee={id:number;name:string;state:EmployeeStatus;task:string|null};
export type StatusSnapshot={revision:number;date:string;generatedAt:string;employees:StatusEmployee[]};
export const EMPLOYEE_STATUS_LABELS:Record<EmployeeStatus,string>={
  picking:"在岗 / Trabajando",
  warehouse:"在岗 / Trabajando",
  ready:"待命 / En espera",
  off:"休息 / Descanso",
  not_started:"未上班 / Sin iniciar",
};

export function employeeTaskStyle(employee:StatusEmployee){
  const task=employee.task?.replace(/ · 已暂停$/,"")??"";
  if(task.startsWith("波次 "))return "wave";
  if(task==="仓务")return "warehouse";
  if(task==="混件扫描"||task==="单件扫描")return "scan";
  if(task==="问题单")return "issue";
  if(task==="清洁")return "clean";
  return task?"other":"idle";
}

const displayTime=new Intl.DateTimeFormat("sv-SE",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
export function statusClock(now:number){
  const parts=displayTime.formatToParts(now);
  const get=(name:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===name)!.value;
  const hour=Number(get("hour"));
  return {date:`${get("year")}-${get("month")}-${get("day")}`,time:`${get("hour")}:${get("minute")}:${get("second")}`,active:hour>=7&&hour<22};
}

export function employeeStatus(onDuty:boolean,hasAttendance:boolean,taskActive:boolean,workType:string|null,barcode:string|null):EmployeeStatus {
  if(!onDuty)return hasAttendance?"off":"not_started";
  if(!taskActive)return "ready";
  return workType==="wave"||barcode==="JOB-SCAN"||barcode==="JOB-SINGLE-SCAN"?"picking":"warehouse";
}

export function sortStatusEmployees(employees:StatusEmployee[]){
  return employees.sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")||a.id-b.id);
}
