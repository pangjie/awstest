import { createHash } from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const {Client}=pg;
const EMPLOYEE_COUNT=20;
const DAY_COUNT=60;
const WAVES_PER_DAY=50;
const TEST_WAVE_PREFIX="WTEST-";
const TEST_EMPLOYEE_PREFIX="TEST·员工";
const EMPLOYEE_ALPHABET="34679CFHKMNRVWXY";
const CHANNELS=["Amazon","Walmart","Temu","TikTok","Wayfair"];
const WAVE_TYPES=["爆品","单件","多件","混件"];
const STANDARD_CODES=["SCAN","SINGLE-SCAN","TODO","WAREHOUSE","CLEAN"];

const client=new Client(connectionConfig());
await client.connect();
try{
  await assertSchema();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(7320250830)");
  await replaceExistingTestData();

  const existingEmployees=(await client.query("SELECT badge_code,employee_code FROM time_employees")).rows;
  const takenBadges=new Set(existingEmployees.map(row=>row.badge_code));
  const takenEmployeeCodes=new Set(existingEmployees.flatMap(row=>row.employee_code?[row.employee_code]:[]));
  const employees=Array.from({length:EMPLOYEE_COUNT},(_,index)=>{
    const name=`TEST·员工${String(index+1).padStart(2,"0")}`;
    const organization_type=index%4===3?"JJC":"OZM";
    const badge_code=generateBadge(name,organization_type,takenBadges,4);
    const employee_code=generateBadge(name,organization_type,takenEmployeeCodes,8);
    takenBadges.add(badge_code);takenEmployeeCodes.add(employee_code);
    return {badge_code,employee_code,name,organization_type,created_at:new Date(Date.now()+index).toISOString()};
  });
  await insertEmployees(employees);

  const now=new Date();
  const today=newYorkDate(now);
  const dates=Array.from({length:DAY_COUNT},(_,index)=>addDays(today,index-(DAY_COUNT-1)));
  const workItems=[];
  const shifts=[];
  const sessions=[];
  const assignments=[];

  for(const [dayIndex,date] of dates.entries()){
    const isToday=date===today;
    const schedule=isToday?todaySchedule(date,now):historicalSchedule(date);
    const attendanceByBadge=new Map();
    for(const [employeeIndex,employee] of employees.entries()){
      const attendance=isToday?todayAttendance(schedule):historicalAttendance(date,dayIndex,employeeIndex);
      attendanceByBadge.set(employee.badge_code,attendance);
      for(const segment of attendance)shifts.push({badge_code:employee.badge_code,work_date:date,clock_in:segment.clockIn,clock_out:segment.clockOut,status:segment.clockOut?"closed":"open",created_at:segment.clockIn});
      const morningCode=STANDARD_CODES[(dayIndex+employeeIndex)%STANDARD_CODES.length];
      appendContainedSession(sessions,{badge_code:employee.badge_code,work_date:date,work_code:morningCode,started_at:attendance[0].clockIn,ended_at:schedule.fixedMorningEnd},attendance);
      if(!isToday){
        const afternoonCode=STANDARD_CODES[(dayIndex+employeeIndex+2)%STANDARD_CODES.length];
        appendContainedSession(sessions,{badge_code:employee.badge_code,work_date:date,work_code:afternoonCode,started_at:schedule.fixedAfternoonStart,ended_at:schedule.fixedAfternoonEnd},attendance);
      }
    }

    for(let waveIndex=0;waveIndex<WAVES_PER_DAY;waveIndex++){
      const sequence=String(waveIndex+1).padStart(3,"0");
      const waveNo=`${TEST_WAVE_PREFIX}${date.replaceAll("-","")}-${sequence}`;
      const channel=CHANNELS[(dayIndex+waveIndex)%CHANNELS.length];
      const channelType=WAVE_TYPES[(dayIndex*3+waveIndex)%WAVE_TYPES.length];
      const active=isToday&&waveIndex>=42;
      const timing=active?schedule.activeTiming:completedWaveTiming(schedule,waveIndex);
      workItems.push({
        barcode:waveNo,code:waveNo,name:`${channel} · ${channelType}`,client:channel,work_type:"wave",wave_no:waveNo,
        channel_name:channel,channel_type:channelType,sku_count:8+(waveIndex*7+dayIndex)%72,
        order_count:24+(waveIndex*19+dayIndex*3)%260,piece_count:40+(waveIndex*31+dayIndex*11)%620,
        sort_order:dayIndex*WAVES_PER_DAY+waveIndex+100,status:active?"active":"completed",
        completed_at:active?null:new Date(new Date(timing.end).getTime()+60_000).toISOString(),created_at:schedule.waveCreatedAt,
      });

      const participantIndexes=active
        ?[2*(waveIndex-42),2*(waveIndex-42)+1]
        :Array.from({length:4},(_,position)=>(waveIndex%5)*4+position);
      participantIndexes.forEach((employeeIndex,position)=>{
        const employee=employees[employeeIndex];
        assignments.push({work_code:waveNo,badge_code:employee.badge_code,role:position===0?"lead":"helper",assigned_at:timing.start});
        appendContainedSession(sessions,{badge_code:employee.badge_code,work_date:date,work_code:waveNo,started_at:timing.start,ended_at:active?null:timing.end},attendanceByBadge.get(employee.badge_code));
      });
    }
  }

  await insertWorkItems(workItems);
  await insertShifts(shifts);
  await insertAssignments(assignments);
  await insertSessions(sessions);
  await insertAttendanceEdits(dates[4],employees.slice(0,10));
  await client.query("INSERT INTO time_revisions(changed_at) VALUES(CURRENT_TIMESTAMP)");
  const summary=await client.query(`SELECT
    (SELECT COUNT(*) FROM time_employees WHERE name LIKE 'TEST·员工%')::INTEGER AS employees,
    (SELECT COUNT(*) FROM time_work_items WHERE wave_no LIKE 'WTEST-%')::INTEGER AS waves,
    (SELECT COUNT(*) FROM time_shifts s JOIN time_employees e ON e.id=s.employee_id WHERE e.name LIKE 'TEST·员工%')::INTEGER AS shifts,
    (SELECT COUNT(*) FROM time_work_sessions ws JOIN time_employees e ON e.id=ws.employee_id WHERE e.name LIKE 'TEST·员工%')::INTEGER AS sessions,
    (SELECT COUNT(*) FROM time_work_items WHERE wave_no LIKE 'WTEST-%' AND status='active')::INTEGER AS active_waves,
    (SELECT COUNT(*) FROM (SELECT s.employee_id,s.work_date FROM time_shifts s JOIN time_employees e ON e.id=s.employee_id WHERE e.name LIKE 'TEST·员工%' GROUP BY s.employee_id,s.work_date HAVING COUNT(*)=2) grouped)::INTEGER AS two_segment_days,
    (SELECT COUNT(*) FROM (SELECT s.employee_id,s.work_date FROM time_shifts s JOIN time_employees e ON e.id=s.employee_id WHERE e.name LIKE 'TEST·员工%' GROUP BY s.employee_id,s.work_date HAVING COUNT(*)=3) grouped)::INTEGER AS three_segment_days,
    (SELECT COUNT(*) FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id JOIN time_employees e ON e.id=ws.employee_id WHERE e.name LIKE 'TEST·员工%' AND (ws.started_at<s.clock_in OR (s.clock_out IS NOT NULL AND (ws.ended_at IS NULL OR ws.ended_at>s.clock_out))))::INTEGER AS sessions_outside_attendance`);
  if(summary.rows[0].sessions_outside_attendance!==0)throw new Error(`存在 ${summary.rows[0].sessions_outside_attendance} 条跨越不在岗时段的工作记录`);
  await client.query("COMMIT");
  await Promise.all([
    client.query("ANALYZE time_employees"),client.query("ANALYZE time_work_items"),client.query("ANALYZE time_shifts"),
    client.query("ANALYZE time_work_sessions"),client.query("ANALYZE time_wave_assignments"),
  ]);
  console.log(JSON.stringify({dateRange:{from:dates[0],to:dates.at(-1)},...summary.rows[0]},null,2));
}catch(error){
  await client.query("ROLLBACK").catch(()=>undefined);
  throw error;
}finally{
  await client.end();
}

function connectionConfig(){
  const base=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:required("DB_HOST"),port:Number(process.env.DB_PORT??5432),database:required("DB_NAME"),user:required("DB_USER"),password:required("DB_PASSWORD")};
  const mode=process.env.DB_SSL??"disable";
  if(mode==="disable")return {...base,ssl:false};
  if(mode!=="verify-full")throw new Error("DB_SSL must be either disable or verify-full");
  return {...base,ssl:{ca:fs.readFileSync(required("DB_CA_PATH"),"utf8"),rejectUnauthorized:true}};
}

function required(name){const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value}
async function assertSchema(){const result=await client.query("SELECT to_regclass('time_employees') AS employees,to_regclass('time_work_items') AS work_items,to_regclass('time_shifts') AS shifts,to_regclass('time_work_session_edits') AS session_edits");if(!result.rows[0].employees||!result.rows[0].work_items||!result.rows[0].shifts||!result.rows[0].session_edits)throw new Error("工时数据表尚未升级，请先启动本地网站并打开任一工时页面")}

function generateBadge(name,type,taken,length){for(let attempt=0;attempt<4096;attempt++){const digest=createHash("sha256").update(`${type}\0${name}\0${attempt}`).digest();const badge=Array.from(digest.subarray(0,length),value=>EMPLOYEE_ALPHABET[value&15]).join("");if(!taken.has(badge))return badge}throw new Error("无法分配测试员工 ID")}
function addDays(date,amount){const value=new Date(`${date}T12:00:00Z`);value.setUTCDate(value.getUTCDate()+amount);return value.toISOString().slice(0,10)}
function newYorkDate(value){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value);const part=type=>parts.find(item=>item.type===type)?.value??"";return `${part("year")}-${part("month")}-${part("day")}`}
function localIso(date,time){
  const match=`${date}T${time}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!match)throw new Error(`Invalid local timestamp ${date} ${time}`);
  const target={year:Number(match[1]),month:Number(match[2]),day:Number(match[3]),hour:Number(match[4]),minute:Number(match[5]),second:Number(match[6]??0)};
  const targetAsUtc=Date.UTC(target.year,target.month-1,target.day,target.hour,target.minute,target.second);
  let candidate=targetAsUtc;
  for(let iteration=0;iteration<4;iteration++){const rendered=zonedParts(new Date(candidate));candidate+=targetAsUtc-Date.UTC(rendered.year,rendered.month-1,rendered.day,rendered.hour,rendered.minute,rendered.second)}
  return new Date(candidate).toISOString();
}
function zonedParts(value){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,hourCycle:"h23"}).formatToParts(value);const part=type=>Number(parts.find(item=>item.type===type)?.value??0);return {year:part("year"),month:part("month"),day:part("day"),hour:part("hour"),minute:part("minute"),second:part("second")}}

function historicalSchedule(date){
  const roundStarts=["08:00","08:42","09:24","10:06","10:48","12:50","13:32","14:14","15:10","15:52"].map(time=>new Date(localIso(date,time)).getTime());
  return {fixedMorningEnd:localIso(date,"07:56"),fixedAfternoonStart:localIso(date,"16:32"),fixedAfternoonEnd:localIso(date,"17:00"),waveCreatedAt:localIso(date,"07:00"),roundStarts,roundDurationMs:36*60_000,activeTiming:null};
}
function historicalAttendance(date,dayIndex,employeeIndex){
  const firstIn=7*60+24+(dayIndex+employeeIndex*3)%12;
  const lunchOut=11*60+42+(dayIndex*2+employeeIndex)%9;
  const lunchIn=12*60+32+(dayIndex+employeeIndex*2)%10;
  const finalOut=17*60+6+(dayIndex*3+employeeIndex)%15;
  const threeSegments=(dayIndex+Math.floor(employeeIndex/4))%9===0;
  const segments=[{clockIn:localIsoMinutes(date,firstIn),clockOut:localIsoMinutes(date,lunchOut)}];
  if(threeSegments){
    const extraOut=14*60+54+(dayIndex+employeeIndex)%3;
    const extraIn=15*60+7+(dayIndex+employeeIndex*2)%3;
    segments.push({clockIn:localIsoMinutes(date,lunchIn),clockOut:localIsoMinutes(date,extraOut)});
    segments.push({clockIn:localIsoMinutes(date,extraIn),clockOut:localIsoMinutes(date,finalOut)});
  }else segments.push({clockIn:localIsoMinutes(date,lunchIn),clockOut:localIsoMinutes(date,finalOut)});
  return segments;
}
function todaySchedule(date,now){
  const midnight=new Date(localIso(date,"00:00")).getTime();
  const nowMs=now.getTime();
  const shiftStartMs=Math.min(nowMs-10*60_000,Math.max(midnight+60_000,nowMs-8*60*60_000));
  const activeStartMs=Math.max(shiftStartMs+6*60_000,nowMs-25*60_000);
  const fixedMorningEndMs=Math.min(shiftStartMs+20*60_000,activeStartMs-4*60_000);
  const roundStartMs=Math.max(shiftStartMs+60_000,fixedMorningEndMs);
  const roundStepMs=Math.max(20_000,Math.floor((activeStartMs-roundStartMs)/9));
  return {shiftStart:new Date(shiftStartMs).toISOString(),shiftEnd:null,fixedMorningEnd:new Date(fixedMorningEndMs).toISOString(),fixedAfternoonStart:null,fixedAfternoonEnd:null,waveCreatedAt:new Date(Math.max(midnight,shiftStartMs-30*60_000)).toISOString(),roundStartMs,roundStepMs,roundDurationMs:Math.max(10_000,Math.floor(roundStepMs*.82)),activeTiming:{start:new Date(activeStartMs).toISOString(),end:null}};
}
function todayAttendance(schedule){return [{clockIn:schedule.shiftStart,clockOut:null}]}
function completedWaveTiming(schedule,waveIndex){const round=Math.floor(waveIndex/5);const start=schedule.roundStarts?.[round]??schedule.roundStartMs+round*schedule.roundStepMs;return {start:new Date(start).toISOString(),end:new Date(start+schedule.roundDurationMs).toISOString()}}
function localIsoMinutes(date,minutes){return localIso(date,`${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`)}
function appendContainedSession(target,row,attendance){
  if(!attendance)throw new Error(`缺少 ${row.badge_code} 在 ${row.work_date} 的考勤区间`);
  const start=new Date(row.started_at).getTime();
  const end=row.ended_at?new Date(row.ended_at).getTime():null;
  const segment=attendance.find(item=>start>=new Date(item.clockIn).getTime()&&(item.clockOut===null||end!==null&&end<=new Date(item.clockOut).getTime()));
  if(!segment)throw new Error(`${row.badge_code} 的 ${row.work_code} 工作记录跨越了 ${row.work_date} 的不在岗时段`);
  target.push({...row,shift_clock_in:segment.clockIn});
}

async function replaceExistingTestData(){
  const employees=`SELECT id FROM time_employees WHERE name LIKE '${TEST_EMPLOYEE_PREFIX}%'`;
  const workItems=`SELECT id FROM time_work_items WHERE wave_no LIKE '${TEST_WAVE_PREFIX}%'`;
  await client.query(`DELETE FROM time_scan_events WHERE employee_id IN (${employees}) OR work_item_id IN (${workItems})`);
  await client.query(`DELETE FROM time_attendance_edits WHERE employee_id IN (${employees})`);
  await client.query(`DELETE FROM time_work_session_edits WHERE employee_id IN (${employees}) OR session_id IN (SELECT id FROM time_work_sessions WHERE work_item_id IN (${workItems}))`);
  await client.query(`DELETE FROM time_work_sessions WHERE employee_id IN (${employees}) OR work_item_id IN (${workItems})`);
  await client.query(`DELETE FROM time_wave_assignments WHERE employee_id IN (${employees}) OR work_item_id IN (${workItems})`);
  await client.query(`DELETE FROM time_shifts WHERE employee_id IN (${employees})`);
  await client.query(`DELETE FROM time_work_items WHERE id IN (${workItems})`);
  await client.query(`DELETE FROM time_employees WHERE id IN (${employees})`);
}

async function insertEmployees(rows){await client.query(`INSERT INTO time_employees(badge_code,employee_code,name,organization_type,active,created_at)
  SELECT badge_code,employee_code,name,organization_type,TRUE,created_at FROM jsonb_to_recordset($1::jsonb)
  AS x(badge_code TEXT,employee_code TEXT,name TEXT,organization_type TEXT,created_at TIMESTAMPTZ)`,[JSON.stringify(rows)])}
async function insertWorkItems(rows){await client.query(`INSERT INTO time_work_items(barcode,code,name,client,work_type,wave_no,channel_name,channel_type,sku_count,order_count,piece_count,sort_order,status,completed_at,created_at)
  SELECT barcode,code,name,client,work_type,wave_no,channel_name,channel_type,sku_count,order_count,piece_count,sort_order,status,completed_at,created_at
  FROM jsonb_to_recordset($1::jsonb) AS x(barcode TEXT,code TEXT,name TEXT,client TEXT,work_type TEXT,wave_no TEXT,channel_name TEXT,channel_type TEXT,sku_count INTEGER,order_count INTEGER,piece_count INTEGER,sort_order INTEGER,status TEXT,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ)`,[JSON.stringify(rows)])}
async function insertShifts(rows){await client.query(`INSERT INTO time_shifts(employee_id,work_date,clock_in,clock_out,status,created_at)
  SELECT e.id,x.work_date,x.clock_in,x.clock_out,x.status,x.created_at FROM jsonb_to_recordset($1::jsonb)
  AS x(badge_code TEXT,work_date TEXT,clock_in TIMESTAMPTZ,clock_out TIMESTAMPTZ,status TEXT,created_at TIMESTAMPTZ)
  JOIN time_employees e ON e.badge_code=x.badge_code`,[JSON.stringify(rows)])}
async function insertAssignments(rows){await client.query(`INSERT INTO time_wave_assignments(work_item_id,employee_id,role,assigned_at)
  SELECT wi.id,e.id,x.role,x.assigned_at FROM jsonb_to_recordset($1::jsonb)
  AS x(work_code TEXT,badge_code TEXT,role TEXT,assigned_at TIMESTAMPTZ)
  JOIN time_work_items wi ON wi.code=x.work_code JOIN time_employees e ON e.badge_code=x.badge_code`,[JSON.stringify(rows)])}
async function insertSessions(rows){await client.query(`INSERT INTO time_work_sessions(shift_id,employee_id,work_item_id,started_at,ended_at)
  SELECT s.id,e.id,wi.id,x.started_at,x.ended_at FROM jsonb_to_recordset($1::jsonb)
  AS x(badge_code TEXT,work_date TEXT,work_code TEXT,shift_clock_in TIMESTAMPTZ,started_at TIMESTAMPTZ,ended_at TIMESTAMPTZ)
  JOIN time_employees e ON e.badge_code=x.badge_code
  JOIN time_shifts s ON s.employee_id=e.id AND s.work_date=x.work_date AND s.clock_in=x.shift_clock_in
  JOIN time_work_items wi ON wi.code=x.work_code`,[JSON.stringify(rows)])}
async function insertAttendanceEdits(workDate,employees){for(const [index,employee] of employees.entries()){const shift=(await client.query("SELECT id,employee_id,clock_in FROM time_shifts WHERE employee_id=(SELECT id FROM time_employees WHERE badge_code=$1) AND work_date=$2 ORDER BY clock_in LIMIT 1",[employee.badge_code,workDate])).rows[0];const minutes=index%3+1;const next=new Date(new Date(shift.clock_in).getTime()-minutes*60_000).toISOString();await client.query("UPDATE time_shifts SET clock_in=$1 WHERE id=$2",[next,shift.id]);await client.query(`INSERT INTO time_attendance_edits(request_id,shift_id,employee_id,work_date,attendance_field,old_timestamp,new_timestamp,note,editor_user_id,editor_username,edited_at)
    VALUES($1,$2,$3,$4,'clock_in',$5,$6,$7,NULL,'TEST-SEED',CURRENT_TIMESTAMP)`,[`test-seed-attendance-${shift.id}`,shift.id,shift.employee_id,workDate,shift.clock_in,next,`测试数据：Sign In 提前 ${minutes} 分钟`])}}
