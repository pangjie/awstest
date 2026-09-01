import { formatClock, formatDuration } from "./format";
import type { EmployeeReport } from "./types";

type AttendanceEvent=EmployeeReport["attendanceEvents"][number];
type WorkProject=EmployeeReport["projects"][number];
type DailyTimelineSource=Pick<EmployeeReport,"generatedAt"|"snapshot"|"attendanceEvents"|"projects">;

export type DailyTimelineRow={
  id:string;
  kind:"attendance"|"work";
  timestamp:string;
  nature:"考勤"|"波次"|"日常";
  waveNo:string;
  content:string;
  clock:string;
  duration:string;
  attendanceEvent:AttendanceEvent|null;
  project:WorkProject|null;
};

export function buildDailyTimelineRows(report:DailyTimelineSource,selectedWorkDate:string,now:number):DailyTimelineRow[] {
  const elapsed=Math.max(0,now-new Date(report.generatedAt).getTime());
  const projects=report.projects.filter(project=>project.workDate===selectedWorkDate);
  return [
    ...report.attendanceEvents.filter(event=>event.workDate===selectedWorkDate).map(event=>({
      id:event.id,kind:"attendance" as const,timestamp:event.timestamp,nature:"考勤" as const,waveNo:"",content:event.label,
      clock:formatClock(event.timestamp),duration:"",attendanceEvent:event,project:null,
    })),
    ...projects.map(project=>({
      id:`work-${project.id}`,kind:"work" as const,timestamp:project.startedAt,nature:project.workType==="wave"?"波次" as const:"日常" as const,
      waveNo:project.workType==="wave"?project.waveNo??"":"",content:project.workType==="wave"?waveSessionContent(project):project.name,
      clock:`${formatClock(project.startedAt)}–${project.endedAt?formatClock(project.endedAt):"进行中"}`,
      duration:formatDuration(project.totalMs+(!project.endedAt&&report.snapshot.state==="working"?elapsed:0)),attendanceEvent:null,project,
    })),
  ].toSorted((left,right)=>new Date(left.timestamp).getTime()-new Date(right.timestamp).getTime());
}

function waveSessionContent(project:WorkProject){
  const channel=project.channelName||"未标注渠道";
  const type=project.channelType||"未标注类型";
  const defaultName=`${channel} · ${type}`;
  const detail=project.name&&project.name!==defaultName&&project.name!==project.waveNo?` · ${project.name}`:"";
  return `${channel} · ${type}${detail} · ${project.skuCount} SKU / ${project.orderCount} 单 / ${project.pieceCount} 件`;
}
