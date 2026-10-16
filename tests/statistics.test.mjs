import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import ExcelJS from "exceljs";
import {exportLoader} from "./helpers/load-export-typescript.mjs";
const load=exportLoader();
const {computeStatistics,statisticsRange}=load("lib/timekeeping/statistics.ts");
const {statisticsSheets}=load("app/timekeeping/statistics-export.ts");
const hour=3600000,date="2026-09-01";
const at=h=>`${date}T${String(h).padStart(2,"0")}:00:00Z`;
const employee=(id,name="同名")=>({id,name,organization:"OZM",active:true});
const item=(id,kind="standard",code="WAREHOUSE",type="")=>({id,kind,code,name:kind==="wave"?"波次":"仓务",type,waveNo:kind==="wave"?`W${id}`:null,channel:"USPS",status:"completed",createdAt:at(12),completedAt:at(22),orders:5,pieces:300});
const shift=(id,employeeId,start,end)=>({id,employeeId,date,start:at(start),end:end===null?null:at(end),modified:false});
const session=(id,employeeId,shiftId,itemId,start,end)=>({id,employeeId,shiftId,itemId,start:at(start),end:end===null?null:at(end),modified:false});
const input=(overrides={})=>({startDate:date,endDate:date,generatedAt:at(23),employees:[employee(1)],shifts:[],sessions:[],items:[],...overrides});

test("statistics summary tables are unpaged and detail navigation uses employee daily totals only",()=>{
  const page=readFileSync("app/timekeeping/statistics-page.tsx","utf8");
  assert.match(page, /compact paginate={false} rows={result.projects}/);
  assert.match(page, /compact paginate={false} rows={result.types}/);
  assert.ok(page.includes("paginate?ordered.slice(current*100,(current+1)*100):ordered"));
  assert.ok(page.includes("people.filter(p=>p.days||p.issues||p.workMs)"));
  assert.ok(page.includes("compact paginate={false} expanded rows={people.filter"));
  assert.ok(page.includes("compact paginate={false} expanded key={employee}"));
  assert.ok(readFileSync("app/timekeeping/statistics.css","utf8").includes(".stats-table.stats-table-expanded{max-height:none;overflow:visible}"));
  assert.doesNotMatch(page,/导出包含完整查询范围，不受页面筛选影响/);
  assert.ok(page.includes("setEmployee(String(p.id));setTab(2)"));
  assert.ok(page.includes("result.daily.filter(d=>d.employeeId===Number(employee))"));
  assert.doesNotMatch(page,/setSearch|setOrganization|includeEmpty|setDetail|setProject|setWave|setDate/);
  assert.match(readFileSync("app/timekeeping/statistics.css","utf8"),/repeat\(11,minmax\(0,1fr\)\)/);
});

test("today snapshot clips running attendance and work, excludes lunch, and stays fixed",()=>{
  const data=input({snapshotAt:at(20),items:[item(1)],shifts:[shift(1,1,12,16),shift(2,1,17,null)],sessions:[session(1,1,1,1,13,16),session(2,1,2,1,18,null)]});
  const r=computeStatistics(data);
  assert.equal(r.isSnapshot,true);assert.equal(r.totals.onDutyMs,7*hour);
  assert.equal(r.totals.workMs,5*hour);assert.equal(r.totals.standbyMs,2*hour);
  assert.equal(r.issues.length,0);assert.equal(data.shifts[1].end,null);assert.equal(data.sessions[1].end,null);
  assert.deepEqual(computeStatistics(data),r);
  const updated=computeStatistics({...data,snapshotAt:at(21)});
  assert.equal(updated.totals.workMs,6*hour);
  assert.ok(statisticsSheets(r).find(s=>s.sheetName==="导出信息").rows.some(row=>row[0]==="统计截至 UTC"&&row[1]===at(20)));
});

test("today counts ongoing wave labor but only completed output and completed picking rate",()=>{
  const r=computeStatistics(input({snapshotAt:at(20),items:[{...item(1,"wave","W1","多件"),completedAt:at(14)},{...item(2,"wave","W2","多件"),status:"active",completedAt:null},{...item(3,"wave","W3","多件"),completedAt:at(21)}],shifts:[shift(1,1,12,null)],sessions:[session(1,1,1,1,12,14),session(2,1,1,2,15,null)]}));
  assert.equal(r.totals.workMs,7*hour);assert.equal(r.totals.pieces,300);assert.equal(r.totals.waves,1);
  assert.equal(r.types.find(t=>t.name==="多件").pickRate,150);
  assert.equal(r.totals.overallEfficiency,37.5);assert.equal(r.issues.length,0);
});

test("today snapshot does not extend historical open records or count future starts",()=>{
  const r=computeStatistics(input({startDate:"2026-08-31",snapshotAt:at(20),items:[item(1)],shifts:[{...shift(1,1,12,null),date:"2026-08-31",start:"2026-08-31T12:00:00Z"},shift(2,1,21,null)],sessions:[{...session(1,1,1,1,13,null),start:"2026-08-31T13:00:00Z"},session(2,1,2,1,21,null)]}));
  assert.equal(r.totals.onDutyMs,0);assert.equal(r.totals.workMs,0);
  assert.ok(r.issues.some(i=>i.message.includes("历史考勤未结束")));
  assert.ok(r.issues.some(i=>i.message.includes("历史任务未结束")));
});

test("closed records after cutoff are clipped without false attendance anomalies",()=>{
  const r=computeStatistics(input({snapshotAt:at(20),items:[item(1)],shifts:[shift(1,1,12,22)],sessions:[session(1,1,1,1,13,21)]}));
  assert.equal(r.totals.onDutyMs,8*hour);assert.equal(r.totals.workMs,7*hour);assert.equal(r.issues.length,0);
});

test("statistics accepts today but not future dates and bounds ranges to three calendar months",()=>{
  assert.equal(statisticsRange("2026-10-01","2026-10-16","2026-10-16").endDate,"2026-10-16");
  assert.throws(()=>statisticsRange("2026-10-01","2026-10-17","2026-10-16"));
  assert.throws(()=>statisticsRange("2026-02-30","2026-03-01","2026-10-16"));
  assert.throws(()=>statisticsRange("2026-01-01","2026-04-01","2026-10-16"));
  assert.equal(statisticsRange("2026-01-01","2026-03-31","2026-10-16").end,"2026-04-01T04:00:00.000Z");
  const dst=statisticsRange("2026-03-08","2026-03-08","2026-10-16");
  assert.equal(Date.parse(dst.end)-Date.parse(dst.start),23*hour);
});

test("attendance, lunch and resumed tasks produce exact standby gaps without double counting",()=>{
  const r=computeStatistics(input({shifts:[shift(1,1,12,16),shift(2,1,17,21)],items:[item(1)],sessions:[session(1,1,1,1,13,15),session(2,1,2,1,18,20)]}));
  assert.equal(r.totals.onDutyMs,8*hour);assert.equal(r.totals.workMs,4*hour);assert.equal(r.totals.standbyMs,4*hour);
  assert.equal(r.totals.workDays,1);assert.equal(r.totals.personDays,1);
  assert.equal(r.fragments.filter(f=>f.standby).length,4);
  assert.equal(r.fragments.some(f=>f.start===at(16)),false);
  assert.equal(r.issues.length,0);
});

test("single and mixed rates use summed picking plus scanning labor, not average rates",()=>{
  const single=item(1,"wave","W1","单件"),mixed={...item(2,"wave","W2","混件"),pieces:200};
  const r=computeStatistics(input({employees:[employee(1),{...employee(2),active:false},employee(3,"无记录")],items:[single,mixed,{...item(3,"standard","SINGLE-SCAN"),name:"单件扫描"},{...item(4,"standard","SCAN"),name:"混件扫描"}],shifts:[shift(1,1,12,21),shift(2,2,12,20)],sessions:[session(1,1,1,1,12,14),session(2,2,2,1,12,13),session(3,1,1,3,14,15),session(4,1,1,2,15,17),session(5,2,2,4,13,15)]}));
  const singleType=r.types.find(t=>t.name==="单件"),mixedType=r.types.find(t=>t.name==="混件");
  assert.equal(singleType.pickRate,100);assert.equal(singleType.scanRate,300);assert.equal(singleType.combinedRate,75);
  assert.equal(mixedType.pickRate,100);assert.equal(mixedType.scanRate,100);assert.equal(mixedType.combinedRate,50);
  assert.equal(r.totals.pieces,500);assert.equal(r.totals.waves,2);assert.equal(r.totals.orders,10);
  assert.equal(r.allocations.filter(a=>a.waveNo==="W1").reduce((n,a)=>n+a.pieces,0),300);
  assert.equal(r.people.find(p=>p.id===1).pieces,400);assert.equal(r.people.find(p=>p.id===2).pieces,100);
  assert.equal(r.people.find(p=>p.id===1).efficiency,100);assert.equal(r.people.find(p=>p.id===2).efficiency,100);
  assert.equal(r.totals.people,2);assert.equal(r.people.find(p=>p.id===3).days,0);
});

test("unfinished tasks are not extrapolated or misclassified as standby",()=>{
  const r=computeStatistics(input({items:[item(1)],shifts:[shift(1,1,12,18)],sessions:[session(1,1,1,1,13,null)]}));
  assert.equal(r.totals.workMs,0);assert.equal(r.totals.standbyMs,0);assert.ok(r.issues.length);
  assert.equal(r.people[0].efficiency,null);
});

test("overlapping tasks are flagged without allocating conflicting time or duplicate production",()=>{
  const r=computeStatistics(input({items:[item(1,"wave","W1","多件"),item(2)],shifts:[shift(1,1,12,18)],sessions:[session(1,1,1,1,12,15),session(2,1,1,2,14,16)]}));
  assert.equal(r.totals.workMs,0);assert.equal(r.totals.standbyMs,2*hour);
  assert.equal(r.allocations.length,0);assert.equal(r.types.find(t=>t.name==="多件").pickRate,null);
  assert.ok(r.issues.some(i=>i.message.includes("重叠")));
});

test("missing scan time never becomes a complete process rate; unknown types remain visible",()=>{
  const r=computeStatistics(input({items:[item(1,"wave","W1","单件"),item(2,"wave","W2","新类型")],shifts:[shift(1,1,12,18)],sessions:[session(1,1,1,1,12,14),session(2,1,1,2,14,15)]}));
  assert.equal(r.types.find(t=>t.name==="单件").combinedRate,null);
  assert.equal(r.types.find(t=>t.name==="未标注").pieces,300);
  assert.equal(r.totals.combinedRate,null);
});

test("unfinished historical waves do not contribute completed output",()=>{
  const r=computeStatistics(input({items:[{...item(1,"wave","W1","单件"),status:"active",completedAt:null}],shifts:[shift(1,1,12,18)],sessions:[session(1,1,1,1,12,14)]}));
  assert.equal(r.totals.pieces,0);assert.equal(r.totals.workMs,2*hour);assert.ok(r.issues.length);
});

test("Excel shares calculation results, contains no employee IDs and preserves numeric durations",async()=>{
  const r=computeStatistics(input({employees:[employee(777,"=NAME")],items:[item(1)],shifts:[shift(1,777,12,18)],sessions:[session(1,777,1,1,12,15)]}));
  const sheets=statisticsSheets(r);assert.equal(sheets.length,6);
  const types=sheets.find(s=>s.sheetName==="波次类型汇总");
  assert.equal(types.rows[0].length,9);
  assert.ok(types.rows.every(row=>row.length===9));
  assert.ok(!types.rows[0].includes("核对状态"));
  assert.deepEqual(sheets.slice(0,4).map(s=>s.sheetName),["总体统计","项目工时","波次类型汇总","员工汇总"]);
  assert.equal(JSON.stringify(sheets).includes("777"),false);
  const book=new ExcelJS.Workbook();
  for(const s of sheets){const w=book.addWorksheet(s.sheetName);w.addRows(s.rows);for(const [i,f] of Object.entries(s.numberFormats))w.getColumn(Number(i)).numFmt=f;for(const [cell,f] of Object.entries(s.cellFormats??{}))w.getCell(cell).numFmt=f}
  const roundtrip=new ExcelJS.Workbook();await roundtrip.xlsx.load(await book.xlsx.writeBuffer());
  const w=roundtrip.getWorksheet("每日汇总");
  assert.equal(w.getCell("B2").value,"=NAME");assert.equal(w.getCell("G2").numFmt,"[h]:mm");
  assert.equal(sheets.find(s=>s.sheetName==="每日汇总").rows[1][6],3/24);
  assert.equal(w.getCell("G2").value.toISOString(),"1899-12-30T03:00:00.000Z");
  assert.equal(sheets[0].rows.length,12);
  assert.deepEqual(sheets[0].rows[0],["统计项","数值"]);
  assert.deepEqual(sheets[0].rows[11],["工作时间占比",0.5]);
  const overview=roundtrip.getWorksheet("总体统计");
  assert.equal(overview.getCell("B8").numFmt,"[h]:mm");
  assert.equal(overview.getCell("B11").numFmt,"0.##");
  assert.equal(overview.getCell("B12").numFmt,"0.0%");
  assert.equal(overview.getCell("B12").value,0.5);
  assert.ok(!sheets.some(s=>["个人波次明细","时间片段","统计口径"].includes(s.sheetName)));
});

test("statistics endpoint is separately authorized, bounded and read-only; worker owns computation",()=>{
  const route=readFileSync("app/api/v1/timekeeping/statistics/route.ts","utf8");
  assert.match(route,/authorizePageAccess\("time-statistics"\)/);
  assert.match(route,/REPEATABLE READ READ ONLY/);assert.match(route,/status:409/);assert.match(route,/LIMIT/);
  assert.doesNotMatch(route,/ensureTimekeepingSchema|reconcileStaleOpenShifts|computeStatistics|INSERT INTO|UPDATE .* SET|DELETE FROM/);
  const page=readFileSync("app/timekeeping/statistics-page.tsx","utf8");
  assert.match(page,/new Worker\(new URL/);assert.doesNotMatch(page,/setInterval|localStorage/);
});

test("Excel includes all recorded employees, omits empty employees, and retains issue warnings",()=>{
  const r=computeStatistics(input({employees:[employee(1),employee(2,"Empty"),{...employee(3,"Inactive"),active:false}],shifts:[shift(1,1,12,null),shift(2,3,12,16)]}));
  const sheets=statisticsSheets(r);
  const employees=sheets.find(s=>s.sheetName==="员工汇总");
  assert.equal(employees.rows.length,3);
  assert.ok(employees.rows.some(row=>row[0]==="Inactive"));
  assert.ok(!employees.rows.some(row=>row[0]==="Empty"));
  assert.ok(sheets.some(s=>s.sheetName==="异常记录"));
  assert.deepEqual(sheets.find(s=>s.sheetName==="每日汇总").rows[0],["日期","姓名",...r.projectNames,"在岗待命","工作时长"]);
});

test("project daily averages and participant-days deduplicate resumed sessions",()=>{
  const nextDay=s=>s.replace("2026-09-01","2026-09-02");
  const laterShift={...shift(2,1,12,18),date:"2026-09-02",start:nextDay(at(12)),end:nextDay(at(18))};
  const laterSession={...session(3,1,2,1,12,14),start:nextDay(at(12)),end:nextDay(at(14))};
  const r=computeStatistics(input({endDate:"2026-09-03",items:[item(1)],shifts:[shift(1,1,12,18),laterShift],sessions:[session(1,1,1,1,12,13),session(2,1,1,1,14,15),laterSession]}));
  const p=r.projects.find(p=>p.name==="仓务");
  assert.equal(p.ms,4*hour);assert.equal(p.count,2);
  assert.equal(p.dailyAverageMs,2*hour);assert.equal(p.averageMs,2*hour);
  const sheet=statisticsSheets(r).find(s=>s.sheetName==="项目工时");
  assert.deepEqual(sheet.rows[0],["项目","总用时","参与人次","工时占比"]);
  assert.equal(sheet.numberFormats[2],"[h]:mm");assert.equal(sheet.numberFormats[4],"0.0%");
  const empty=computeStatistics(input()).projects[0];
  assert.equal(empty.dailyAverageMs,0);assert.equal(empty.averageMs,0);
});

test("project order is stable and overall efficiency includes standby attendance",()=>{
  const r=computeStatistics(input({items:[item(1,"wave","W1","多件")],shifts:[shift(1,1,12,18)],sessions:[session(1,1,1,1,12,15)]}));
  assert.deepEqual(r.projects.slice(0,7).map(p=>p.name),["波次拣货","单件扫描","混件扫描","问题单","仓务","清洁","在岗待命"]);
  assert.equal(r.totals.overallEfficiency,50);
  assert.equal(r.types.find(t=>t.name==="多件").scanMs,0);
  for(const s of statisticsSheets(r).filter(s=>["员工汇总","每日汇总","个人波次明细"].includes(s.sheetName))){
    assert.doesNotMatch(s.rows[0].join(","),/组织|折算件数|时效|异常数量|在岗合计|完成波次/);
  }
  assert.equal(computeStatistics(input()).totals.overallEfficiency,null);
});
