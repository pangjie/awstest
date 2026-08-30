export type EmployeeSnapshot={
  employee:{id:number;badgeCode:string;name:string;type:"OZM"|"JJC";active:boolean};
  shift:{id:number;workDate:string;clockIn:string;clockOut:string|null}|null;
  state:"inactive"|"not_started"|"off"|"ready"|"working";
  currentProject:{id:number;code:string;name:string;workType:"wave"|"standard";waveNo:string|null;status:string;assignmentRole:"lead"|"helper"|null;startedAt:string}|null;
  today:{onDutyMs:number;productiveMs:number;offDutyMs:number};
};

export type EmployeeRecord={id:number;badgeCode:string;name:string;type:"OZM"|"JJC";active:boolean;attendanceState:string;currentProject:{code:string;name:string}|null;todayFirstSignIn:string|null;todayLastSignOut:string|null;todayOffDutyMs:number;todayMs:number;createdAt:string};
export type EmployeesResponse={ok:true;generatedAt:string;period:{today:string};employees:EmployeeRecord[]};

export type WorkParticipant={employeeId:number;name:string;totalMs:number;firstStartedAt:string;lastEndedAt:string|null;sessionCount:number;active:boolean;onDuty:boolean;role:"lead"|"helper"};
export type WorkItem={id:number;barcode:string;code:string;waveNo:string|null;name:string;client:string;channelName:string;channelType:string;workType:"wave"|"standard";skuCount:number;orderCount:number;pieceCount:number;sortOrder:number;status:"active"|"completed";createdAt:string;completedAt:string|null;startedAt:string|null;lastEndedAt:string|null;totalMs:number;employeeCount:number;activeCount:number;participants:WorkParticipant[]};
export type ScanOperation={id:string;time:string;event:string;tone:"success"|"info"|"warning"|"error";message:string;employeeId:number|null;employeeName:string;operator:string};
export type WorkItemsResponse={ok:true;generatedAt:string;standardTasks:WorkItem[];currentWaves:WorkItem[];historyWaves:WorkItem[];todayOperations:ScanOperation[]};

export type ScanResponse={ok:boolean;event:string;message:string;tone:"success"|"info"|"warning"|"error";duplicate?:boolean;employeeId?:number;snapshot?:EmployeeSnapshot;contextExpiresAt?:number};

export type DashboardResponse={
  ok:true;date:string;range:{id:"1d"|"3d"|"7d"|"14d"|"30d";label:string;startDate:string;endDate:string;start:string;end:string};revision:number;generatedAt:string;timeZone:string;filterUniverse:{channels:string[]};
  attendance:Array<{employeeId:number;name:string;type:string;clockIn:string|null;clockOut:string|null;onDutyMs:number;productiveMs:number;offDutyMs:number;state:string;currentProject:{code:string;name:string}|null}>;
  taskTotals:{totalMs:number;waveMs:number;scanMs:number;otherMs:number;activeCount:number;waveActiveCount:number;scanActiveCount:number;otherActiveCount:number};
  dailyTasks:Array<{id:number;code:string;name:string;sortOrder:number;totalMs:number;activeCount:number;participants:Array<{employeeId:number;name:string;totalMs:number;active:boolean}>}>;
  projectTotals:WorkItem[];
  anomalies:Array<{level:"warning"|"info";employee:string;message:string}>;
};

export type EmployeeReport={
  ok:true;generatedAt:string;snapshot:EmployeeSnapshot;
  period:{id:string;label:string;startDate:string;endDate:string;previous:string;next:string;totalMs:number;workedDays:number};defaultWorkDate:string;
  days:Array<{workDate:string;clockIn:string;clockOut:string|null;productiveMs:number;onDutyMs:number;offDutyMs:number}>;
  attendanceEvents:Array<{id:string;shiftId:number;workDate:string;field:"clock_in"|"clock_out";type:"sign_in"|"sign_out";label:"Sign In"|"Sign Out";timestamp:string;modified:boolean}>;
  attendanceEdits:Array<{id:number;requestId:string;shiftId:number;workDate:string;field:"clock_in"|"clock_out";label:string;oldTimestamp:string;newTimestamp:string;note:string;editor:string;editedAt:string}>;
  workSessionEdits:Array<{id:number;requestId:string;sessionId:number;workDate:string;field:"started_at"|"ended_at";label:string;workCode:string;workName:string;oldTimestamp:string;newTimestamp:string;note:string;editor:string;editedAt:string}>;
  projects:Array<{id:number;workDate:string;code:string;name:string;workType:string;waveNo:string|null;channelName:string;channelType:string;skuCount:number;orderCount:number;pieceCount:number;startedAt:string;endedAt:string|null;startedAtModified:boolean;endedAtModified:boolean;totalMs:number}>;
};
