import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import pg from "pg";
import {drizzle} from "drizzle-orm/node-postgres";
import {exportLoader} from "./helpers/load-export-typescript.mjs";
import {STANDARD_TASKS} from "../lib/timekeeping/standard-tasks.ts";

test("new fixed tasks preserve defaults, lunch breaks, switches and next-day selection in isolated PostgreSQL",{skip:process.env.RUN_STANDARD_TASK_PG_TESTS!=="1"},async t=>{
  const url=new URL(process.env.DATABASE_URL);
  assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname),"Only local PostgreSQL may be used");
  const schema=`test_standard_tasks_${randomBytes(8).toString("hex")}`;
  const admin=new pg.Pool({connectionString:url.toString()});
  const pool=new pg.Pool({connectionString:url.toString(),options:`-c search_path=${schema}`,max:4});
  const database={getPool:()=>pool,getDb:()=>drizzle(pool)};
  const loader=()=>exportLoader({"../../db":database,"./index":database});
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query("CREATE TABLE users(id integer primary key);INSERT INTO users VALUES(1)");
    const load=loader();
    await load("db/timekeeping-runtime.ts").ensureTimekeepingSchema();
    const rows=(await pool.query("SELECT id,code,name,barcode FROM time_work_items WHERE work_type='standard' ORDER BY sort_order,id")).rows;
    assert.deepEqual(rows.map(row=>row.code),STANDARD_TASKS.map(task=>task.code));
    // A fresh application process re-runs additive setup without changing task identities.
    await loader()("db/timekeeping-runtime.ts").ensureTimekeepingSchema();
    assert.deepEqual((await pool.query("SELECT id,code,name,barcode FROM time_work_items WHERE work_type='standard' ORDER BY sort_order,id")).rows,rows);

    const {performScan}=load("lib/timekeeping/scan.ts");
    const user={id:1,username:"test-admin"};
    t.mock.timers.enable({apis:["Date"],now:Date.parse("2026-11-02T13:00:00Z")});
    const setTime=(day,hour)=>t.mock.timers.setTime(Date.parse(`2026-11-0${day}T${String(hour+5).padStart(2,"0")}:00:00Z`));
    let sequence=0;
    for(const [index,code] of ["PUTAWAY","LOCATION-MAINTENANCE"].entries()){
      const task=rows.find(row=>row.code===code),other=rows.find(row=>row.code===(code==="PUTAWAY"?"LOCATION-MAINTENANCE":"PUTAWAY"));
      assert.ok(task);assert.ok(other);
      const employee=(await pool.query("INSERT INTO time_employees(badge_code,employee_code,name,default_work_item_id) VALUES($1,$2,$3,$4) RETURNING id",[`TEST${index}`,`TEST000${index}`,`Test ${task.name}`,task.id])).rows[0];
      const scan=async(action,extra={})=>{
        const input={code:action,employeeId:employee.id,requestId:`fixed-${++sequence}`,terminalId:`test-${index}`,...extra};
        const result=await performScan(user,input);
        assert.equal(result.status,200,JSON.stringify(result.response));
        return {input,...result.response};
      };

      setTime(2,8);
      const started=await scan("ACT-CLOCKIN");
      assert.equal(started.event,"CLOCK_IN_PROJECT_START");
      assert.equal(started.snapshot.currentProject.code,code);
      const repeated=await performScan(user,started.input);
      assert.equal(repeated.response.duplicate,true);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM time_work_sessions WHERE employee_id=$1",[employee.id])).rows[0].count),1);

      setTime(2,12);
      const paused=await scan("ACT-OUT");
      assert.equal(paused.snapshot.state,"off");
      assert.equal(paused.snapshot.currentProject.code,code);
      assert.match(paused.message,/计时已暂停/);
      assert.doesNotMatch(paused.message,/计时已结束/);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM time_work_sessions WHERE employee_id=$1 AND ended_at IS NULL",[employee.id])).rows[0].count),0);

      setTime(2,13);
      const resumed=await scan("ACT-CLOCKIN");
      assert.equal(resumed.event,"CLOCK_IN_PROJECT_RESUME");
      assert.equal(resumed.snapshot.currentProject.code,code);
      setTime(2,14);
      const switched=await scan(other.barcode);
      assert.equal(switched.snapshot.currentProject.code,other.code);
      assert.equal(Number((await pool.query("SELECT COUNT(*) FROM time_work_sessions WHERE employee_id=$1 AND ended_at IS NULL",[employee.id])).rows[0].count),1);
      const duplicateSwitch=await performScan(user,switched.input);
      assert.equal(duplicateSwitch.response.duplicate,true);
      setTime(2,15);await scan("ACT-OUT");

      setTime(3,8);
      const nextDay=await scan("ACT-CLOCKIN");
      assert.equal(nextDay.event,"CLOCK_IN_PROJECT_START");
      assert.equal(nextDay.snapshot.currentProject.code,code,"yesterday's temporary task must not replace the default function");
      setTime(3,9);await scan("ACT-OUT");
      setTime(3,10);
      const preferred=await scan("ACT-CLOCKIN",{projectCode:other.barcode});
      assert.equal(preferred.event,"CLOCK_IN_PROJECT_START");
      assert.equal(preferred.snapshot.currentProject.code,other.code,"an explicit selection must override the paused/default task");
      setTime(3,11);await scan("ACT-OUT");

      const totals=(await pool.query(`SELECT wi.code,s.work_date,SUM(EXTRACT(EPOCH FROM ws.ended_at-ws.started_at))/3600 AS hours
        FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id JOIN time_work_items wi ON wi.id=ws.work_item_id
        WHERE ws.employee_id=$1 GROUP BY wi.code,s.work_date`,[employee.id])).rows;
      const hours=(day,taskCode)=>Number(totals.find(row=>row.work_date===`2026-11-0${day}`&&row.code===taskCode)?.hours);
      assert.equal(hours(2,code),5,"the one-hour lunch break is excluded");
      assert.equal(hours(2,other.code),1);
      assert.equal(hours(3,code),1);
      assert.equal(hours(3,other.code),1);
      const invalid=await pool.query(`SELECT ws.id FROM time_work_sessions ws JOIN time_shifts s ON s.id=ws.shift_id
        WHERE ws.employee_id=$1 AND (ws.ended_at IS NULL OR ws.started_at<s.clock_in OR ws.ended_at>s.clock_out)`,[employee.id]);
      assert.equal(invalid.rowCount,0,"every task segment remains within attendance");
    }
  }finally{
    t.mock.timers.reset();
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }
});
