import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root=new URL("../",import.meta.url);
const read=path=>readFile(new URL(path,root),"utf8");

// Node can execute TypeScript directly, but it does not add .ts to extensionless
// imports. Copy only the pure modules under test and make those imports explicit.
const pureModuleNames=[
  "location-import","location-search","reserve-inventory-excel","reserve-statistics",
  "page-permissions","sku-catalog","task-sheet-pdf","warehouse-ledger-excel","warehouse-time",
];
const pureModuleDirectory=await mkdtemp(join(tmpdir(),"neiku-pure-modules-"));
for(const name of pureModuleNames) {
  const source=(await read(`lib/${name}.ts`)).replace(/from "(\.\/[^"]+)"/g,'from "$1.ts"');
  await writeFile(join(pureModuleDirectory,`${name}.ts`),source);
}
after(()=>rm(pureModuleDirectory,{recursive:true,force:true}));
const loadPure=name=>import(pathToFileURL(join(pureModuleDirectory,`${name}.ts`)).href);

test("keeps CI on dev and production deployment behind a merged main PR",async()=>{
  const [ci,deploy]=await Promise.all([read(".github/workflows/ci.yml"),read(".github/workflows/deploy.yml")]);
  assert.match(ci,/pull_request:\n\s+branches: \[main\]/);
  assert.match(ci,/push:\n\s+branches: \[dev\]/);
  assert.match(deploy,/push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(deploy,/workflow_dispatch/);
  assert.match(deploy,/commits\/\$\{GITHUB_SHA\}\/pulls/);
  assert.match(deploy,/select\(\.base\.ref == "main" and \.merged_at != null\)/);
  assert.match(deploy,/id-token: write/);
  assert.match(deploy,/configure-aws-credentials/);
  assert.match(deploy,/aws ssm send-command/);
  assert.doesNotMatch(`${ci}\n${deploy}`,/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
});

test("separates process liveness from database readiness",async()=>{
  const [live,ready]=await Promise.all([read("app/health/live/route.ts"),read("app/health/ready/route.ts")]);
  assert.doesNotMatch(live,/database|isDatabaseReady|getPool/i);
  assert.match(live,/status:"ok"/);
  assert.match(ready,/isDatabaseReady/);
  assert.match(ready,/status:"not_ready"/);
  assert.match(ready,/status:503/);
  assert.match(`${live}\n${ready}`,/cache-control":"no-store/);
  await assert.rejects(read("app/api/v1/health/route.ts"),error=>error?.code==="ENOENT");
});

test("uses one backward-compatible runtime schema path",async()=>{
  const [runtime,packageText]=await Promise.all([read("db/runtime.ts"),read("package.json")]);
  const packageJson=JSON.parse(packageText);
  assert.match(runtime,/POSTGRES_RUNTIME_SCHEMA_VERSION=1006/);
  assert.match(runtime,/pg_advisory_lock/);
  assert.match(runtime,/client\.query\("BEGIN"\)/);
  assert.match(runtime,/CREATE TABLE IF NOT EXISTS/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS source_record_id INTEGER/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS remarks TEXT/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS page_permissions TEXT\[\]/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/);
  assert.match(runtime,/ON CONFLICT\(id\) DO UPDATE/);
  assert.match(runtime,/client\.query\("COMMIT"\)/);
  assert.doesNotMatch(runtime,/DROP TABLE|DROP COLUMN|TRUNCATE/i);
  assert.equal(packageJson.scripts["db:generate"],undefined);
  assert.equal(packageJson.devDependencies["drizzle-kit"],undefined);
  await Promise.all([
    assert.rejects(read("drizzle.config.ts"),error=>error?.code==="ENOENT"),
    assert.rejects(read("drizzle/0000_bent_bruce_banner.sql"),error=>error?.code==="ENOENT"),
  ]);
});

test("grants admin every registered page and keeps ordinary accounts explicitly scoped",async()=>{
  const permissions=await loadPure("page-permissions");
  const keys=permissions.PAGE_DEFINITIONS.map(page=>page.key);
  assert.equal(new Set(keys).size,11);
  assert.deepEqual(
    permissions.NAVIGATION_DEFINITIONS.map(page=>page.label),
    ["备货操作","备库总表","备货数据","任务分发","工卡扫描","现场看板","工作记录","员工数据"],
  );
  assert.deepEqual(
    permissions.WAREHOUSE_DATA_TABS.map(page=>page.key),
    ["tasks","sku-management","location-management","warehouse-ledger"],
  );
  assert.deepEqual(
    permissions.TIMEKEEPING_PAGES.map(page=>page.key),
    ["time-scan","time-card-scan","time-dashboard","time-records","time-employees"],
  );
  assert.equal(keys.includes("reserve-statistics"),false);
  assert.deepEqual(permissions.effectivePagePermissions("admin",[]),keys);
  assert.deepEqual(
    permissions.effectivePagePermissions("operator",["dashboard","removed-page","dashboard"]),
    ["dashboard"],
  );
  assert.equal(permissions.canAccessAnyPage({role:"operator",pagePermissions:["dashboard"]},["dashboard"]),true);
  assert.equal(permissions.canAccessAnyPage({role:"operator",pagePermissions:["dashboard"]},["sku-management"]),false);

  const [schema,runtime,auth,app,usersRoute]=await Promise.all([
    read("db/schema.ts"),read("db/runtime.ts"),read("lib/internal-auth.ts"),
    read("app/warehouse-app.tsx"),read("app/api/v1/users/route.ts"),
  ]);
  assert.match(schema,/pagePermissions: text\("page_permissions"\)\.array\(\)\.notNull\(\)/);
  assert.match(runtime,/ALTER TABLE users ALTER COLUMN page_permissions SET NOT NULL/);
  assert.match(auth,/authorizePageAccess/);
  assert.match(auth,/effectivePagePermissions\(current\.role,current\.pagePermissions\)/);
  assert.match(app,/visiblePages\.map\(\(page,index\)=>/);
  assert.match(app,/active==="备货数据"/);
  assert.match(app,/downloadReserveStatisticsWorkbook\(statistics\)/);
  assert.doesNotMatch(app,/active==="备货统计"/);
  assert.match(app,/PermissionChecklist/);
  assert.match(usersRoute,/pagePermissions\.length===0/);
});

test("keeps the desktop sidebar compact and stacks time below the date",async()=>{
  const css=await read("app/warehouse-enhancements.css");
  assert.match(css,/@media \(min-width: 761px\) \{[\s\S]*?\.sidebar \{[\s\S]*?width: 180px;/);
  assert.match(css,/\.workspace \{[\s\S]*?width: calc\(100% - 180px\);[\s\S]*?margin-left: 180px;/);
  assert.match(css,/\.sidebar-date \{[\s\S]*?grid-template-columns: minmax\(0,1fr\);/);
  assert.match(css,/\.sidebar-clock \{[\s\S]*?display: flex;[\s\S]*?width: 100%;/);
  assert.match(css,/\.sidebar-bottom > \.nav-item \{[\s\S]*?height: 34px;/);
  assert.match(css,/\.sidebar-bottom \.avatar \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
});

test("keeps the fresh timekeeping system isolated behind five page permissions",async()=>{
  const paths=[
    "db/timekeeping-schema.ts","db/timekeeping-runtime.ts",
    "lib/timekeeping/dashboard-range.ts","lib/timekeeping/data.ts","lib/timekeeping/read-model.ts","lib/timekeeping/scan.ts","lib/timekeeping/time.ts",
    "app/timekeeping/timekeeping-module.tsx","app/timekeeping/scan-page.tsx","app/timekeeping/card-scan-page.tsx","app/timekeeping/daily-timeline.ts","app/timekeeping/dashboard-page.tsx","app/timekeeping/wave-display.tsx",
    "app/timekeeping/records-page.tsx","app/timekeeping/employees-page.tsx",
    "app/api/v1/timekeeping/scan/route.ts","app/api/v1/timekeeping/card-scan/route.ts","app/api/v1/timekeeping/dashboard/route.ts",
    "app/api/v1/timekeeping/records/route.ts","app/api/v1/timekeeping/employees/route.ts",
    "app/api/v1/timekeeping/waves/route.ts","app/api/v1/timekeeping/revision/route.ts",
  ];
  const sources=await Promise.all(paths.map(async path=>[path,await read(path)]));
  const combined=sources.map(([,source])=>source).join("\n");
  const runtime=await read("db/timekeeping-runtime.ts");
  const schema=await read("db/timekeeping-schema.ts");
  const app=await read("app/warehouse-app.tsx");

  for(const table of ["time_employees","time_work_items","time_shifts","time_attendance_edits","time_work_sessions","time_work_session_edits","time_wave_assignments","time_scan_events","time_revisions","time_runtime_schema_state"]) {
    assert.match(schema,new RegExp(`"${table}"`),`${table} must be registered in the isolated schema`);
    assert.match(runtime,new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`),`${table} must be created additively`);
  }
  assert.match(runtime,/TIMEKEEPING_SCHEMA_VERSION=4/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS employee_code TEXT/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS interrupted_at TIMESTAMPTZ/);
  assert.match(schema,/interruptedAt:utcTimestamp\("interrupted_at"\)/);
  assert.match(runtime,/pg_advisory_lock/);
  assert.match(runtime,/JOB-SCAN/);
  assert.doesNotMatch(runtime,/DROP TABLE|DROP COLUMN|TRUNCATE|INSERT INTO time_employees/i);
  assert.doesNotMatch(combined,/D1Database|wrangler|cloudflare|\/工时系统|\/备货管理系统/);
  for(const [path,source] of sources.filter(([path])=>path.includes("/timekeeping/")||path.startsWith("lib/timekeeping/"))) {
    assert.doesNotMatch(source,/from ["'][^"']*warehouse-(?:data|read-model|revision|ledger|inventory)/,`${path} must not import warehouse business logic`);
  }
  assert.match(app,/activeTimekeepingPage&&<TimekeepingModule/);
  assert.match(await read("app/api/v1/timekeeping/scan/route.ts"),/authorizePageAccess\("time-scan"\)/);
  assert.match(await read("app/api/v1/timekeeping/dashboard/route.ts"),/authorizePageAccess\("time-dashboard"\)/);
  const dashboardRoute=await read("app/api/v1/timekeeping/dashboard/route.ts");
  assert.match(dashboardRoute,/searchParams\.get\("startDate"\)/);
  assert.match(dashboardRoute,/searchParams\.get\("endDate"\)/);
  const recordsApiRoute=await read("app/api/v1/timekeeping/records/route.ts");
  assert.match(recordsApiRoute,/authorizePageAccess\("time-records"\)/);
  assert.match(recordsApiRoute,/export async function PATCH[\s\S]*authorizePageAccess\("time-records"\)/);
  const cardScanRoute=await read("app/api/v1/timekeeping/card-scan/route.ts");
  assert.match(cardScanRoute,/authorizePageAccess\("time-card-scan"\)/);
  assert.match(cardScanRoute,/code!=="ACT-CLOCKIN"&&code!=="ACT-OUT"/);
  assert.match(cardScanRoute,/performScan\(access\.user,\{code,employeeId:input\.employeeId,requestId:input\.requestId,terminalId:"mobile-card"\}\)/);
  assert.match(cardScanRoute,/attendanceEvents:report\.attendanceEvents\.filter\(event=>event\.workDate===today\)/);
  assert.match(cardScanRoute,/projects:report\.projects\.filter\(project=>project\.workDate===today\)/);
  assert.match(await read("app/api/v1/timekeeping/employees/route.ts"),/authorizePageAccess\("time-employees"\)/);
  const employeeIds=await import(new URL("../lib/timekeeping/employee-id.ts",import.meta.url));
  const generatedEmployeeId=await employeeIds.generateEmployeeId("测试员工","OZM",new Set());
  assert.equal(generatedEmployeeId.length,8);
  assert.equal(employeeIds.isValidEmployeeId(generatedEmployeeId),true);
  assert.equal(employeeIds.isValidEmployeeId(generatedEmployeeId.slice(0,4)),true,"legacy IDs stay readable during rollback");
  const employeesPage=await read("app/timekeeping/employees-page.tsx");
  for(const label of ["Sign In","Sign Out","最早 Sign In","最晚 Sign Out","当日不在岗"])assert.match(employeesPage,new RegExp(label));
  assert.match(employeesPage,/todayOffDutyMs/);
  assert.doesNotMatch(employeesPage,/thisWeekMs|lastWeekMs|label="本周"|label="上周"/);
  for(const field of ["badgeCode","name","type","attendanceState","todayFirstSignIn","todayLastSignOut","todayOffDutyMs","currentProject","todayMs"])assert.match(employeesPage,new RegExp(`field="${field}"`));
  assert.doesNotMatch(employeesPage,/useState<.*Sort.*>\(/);
  assert.match(app,/useState<EmployeeSortState>\(\{key:"name",descending:false\}\)/);
  assert.match(app,/employeeSort=\{timeEmployeeSort\} setEmployeeSort=\{setTimeEmployeeSort\}/);
  assert.match(await read("app/timekeeping/timekeeping-module.tsx"),/sortState=\{employeeSort\} setSortState=\{setEmployeeSort\}/);
  assert.match(employeesPage,/const \{key:sort,descending\}=sortState/);
  assert.match(employeesPage,/setSortState\(current=>/);
  assert.match(employeesPage,/leftRow\.index-rightRow\.index/);
  assert.match(employeesPage,/aria-sort=/);
  assert.match(employeesPage,/createPortal\(<div className="time-employee-titlebar"/);
  assert.match(employeesPage,/className="time-employee-title-filters"/);
  assert.match(employeesPage,/className="time-employee-scan-link"/);
  assert.match(employeesPage,/isAdmin&&<button className="time-secondary"/);
  assert.match(employeesPage,/导出扫描素材/);
  assert.match(employeesPage,/\/api\/v1\/timekeeping\/employees\/export/);
  assert.match(app,/setTimeScanBadge\(badge\);setActive\("任务分发"\)/);
  assert.doesNotMatch(employeesPage,/action==="sign_out"&&!window\.confirm/);
  assert.doesNotMatch(employeesPage,/员工主数据|员工 ID 由系统自动生成|className="time-toolbar"/);
  assert.doesNotMatch(employeesPage,/className="time-hero"/);
  assert.match(await read("lib/timekeeping/read-model.ts"),/todayLastSignOut:toIsoOrNull\(todayLastSignOut\)/);
  const employeeExportRoute=await read("app/api/v1/timekeeping/employees/export/route.ts");
  const employeeExport=await read("lib/timekeeping/employee-scan-export.ts");
  assert.match(employeeExportRoute,/authorizePageAccess\("time-employees"\)/);
  assert.match(employeeExportRoute,/access\.user\.role!=="admin"/);
  assert.match(employeeExportRoute,/content-type":"application\/zip"/);
  assert.match(employeeExport,/BARCODE_PNG_WIDTH=1200/);
  assert.match(employeeExport,/BARCODE_PNG_HEIGHT=300/);
  assert.match(employeeExport,/QR_PNG_SIZE=600/);
  for(const folder of ["条码-PNG","条码-SVG","二维码-PNG","二维码-SVG"])assert.match(employeeExport,new RegExp(folder));
  assert.match(employeeExport,/Code 128 条码/);
  const wavesRoute=await read("app/api/v1/timekeeping/waves/route.ts");
  assert.match(wavesRoute,/authorizePageAccess\("time-scan","time-dashboard"\)/);
  assert.match(wavesRoute,/authorizePageAccess\("time-dashboard"\)/);
  assert.match(wavesRoute,/body\.action==="complete"\|\|body\.action==="interrupt"/);
  assert.match(wavesRoute,/interruptedAt:now/);
  assert.match(wavesRoute,/只有正在进行的波次可以中断/);
  assert.doesNotMatch(wavesRoute,/time-waves/);
  await assert.rejects(read("app/timekeeping/waves-page.tsx"),error=>error?.code==="ENOENT");
  const scanLogic=await read("lib/timekeeping/scan.ts");
  const timekeepingData=await read("lib/timekeeping/data.ts");
  assert.match(timekeepingData,/eq\(timeShifts\.workDate,today\)/);
  assert.match(timekeepingData,/const pausedStandard=latestTodaySession\?\.workType==="standard"&&latestTodaySession\.status==="active"\?latestTodaySession:null/);
  assert.match(timekeepingData,/currentProject=activeSession\?\?pausedStandard\?\?attachedWave/);
  assert.match(scanLogic,/snapshot\.currentProject\?await findActiveWorkItem\(tx,snapshot\.currentProject\.code\):null/);
  assert.match(scanLogic,/CLOCK_IN_PROJECT_RESUME/);
  assert.match(scanLogic,/今天再次 Sign In 后继续/);
  assert.match(scanLogic,/已完结，计时已结束/);
  assert.match(scanLogic,/pausedProject\?`\$\{snapshot\.employee\.name\}，Sign Out 成功 · \$\{pausedProject\.waveNo\?\?pausedProject\.code\} 计时已暂停/);
  assert.match(scanLogic,/lockTimekeeping\(tx\)/);
  assert.match(scanLogic,/timeScanEvents\.responsePayload/);
  assert.match(scanLogic,/isNull\(timeWorkItems\.interruptedAt\)/);
  assert.match(scanLogic,/set\(\{interruptedAt:null\}\)/);
  const scanPage=await read("app/timekeeping/scan-page.tsx");
  assert.match(scanPage,/window\.setTimeout\(\(\)=>\{if\(snapshot\)selectScannedCode\(normalized\);else void scan\(normalized\)\},320\)/);
  assert.match(scanPage,/isValidEmployeeId\(normalized\)\)\{void scan\(normalized\);return\}/);
  assert.match(scanPage,/className="time-scan-grid"/);
  assert.doesNotMatch(scanPage,/\{snapshot&&<div className="time-scan-grid"/);
  assert.match(scanPage,/确认 \/ CONFIRM/);
  assert.doesNotMatch(scanPage,/Sign Out？固定任务会保留|Sign Out？当前工作计时/);
  assert.match(scanPage,/switchingTask\?`确定将任务从/);
  assert.match(scanPage,/<span>已暂停<\/span>/);
  assert.match(scanPage,/onClick=\{confirmSelection\}/);
  assert.match(scanPage,/selection\.confirmMessage&&!window\.confirm/);
  assert.match(scanPage,/onClick=\{\(\)=>selectAction\("clock-in"\)\}/);
  assert.match(scanPage,/onClick=\{\(\)=>selectItem\(item\)\}/);
  assert.doesNotMatch(scanPage,/onClick=\{\(\)=>void scan\("ACT-(?:CLOCKIN|OUT|WAVE-COMPLETE)"/);
  assert.match(scanPage,/今日操作/);
  assert.match(scanPage,/todayOperations/);
  assert.match(scanPage,/employeeOperations/);
  assert.match(scanPage,/今日记录/);
  assert.match(scanPage,/createPortal\(<div className="time-scan-titlebar"/);
  assert.doesNotMatch(scanPage,/time-scan-title-copy|扫码工作台|等待扫描员工卡/);
  assert.match(scanPage,/className="time-current-employee"/);
  assert.ok(scanPage.indexOf("time-current-employee")<scanPage.indexOf("time-current-task"),"姓名必须在当前任务上方");
  assert.match(scanPage,/selected\?"selected":""/);
  assert.match(scanPage,/currentProjectId=\{snapshot\?\.currentProject\?\.id\?\?null\}/);
  assert.match(scanPage,/selectedProjectId=\{selection\?\.projectId\?\?null\}/);
  assert.ok(scanPage.indexOf("time-button-row")<scanPage.indexOf("time-current-history"),"今日记录必须显示在当前状态操作按钮下方");
  assert.doesNotMatch(scanPage,/本机最近操作|setLogs|完结波次并 Sign Out/);
  const cardScanPage=await read("app/timekeeping/card-scan-page.tsx");
  const dailyTimeline=await read("app/timekeeping/daily-timeline.ts");
  const timekeepingCss=await read("app/timekeeping.css");
  const recordsPage=await read("app/timekeeping/records-page.tsx");
  assert.match(cardScanPage,/BrowserMultiFormatReader/);
  assert.match(cardScanPage,/decodeFromConstraints/);
  assert.match(cardScanPage,/facingMode:\{ideal:"user"\}/);
  assert.match(cardScanPage,/activeControls\.stop\(\)/);
  assert.match(cardScanPage,/setReport\(null\);setSelection\(null\);setNotice/);
  for(const label of ["扫描","Sign In","Sign Out","Confirm","姓名","当天处理内容"])assert.match(cardScanPage,new RegExp(label));
  assert.doesNotMatch(cardScanPage,/className="time-card-scan-heading"|<span>IN<\/span>|<span>OUT<\/span>|<span>✓<\/span>/);
  assert.doesNotMatch(cardScanPage,/window\.confirm/);
  assert.match(cardScanPage,/\/api\/v1\/timekeeping\/card-scan/);
  assert.match(cardScanPage,/buildDailyTimelineRows\(report,report\.workDate,now\)/);
  assert.match(recordsPage,/buildDailyTimelineRows\(report,selectedWorkDate,now\)/);
  assert.match(dailyTimeline,/attendanceEvents\.filter/);
  assert.match(dailyTimeline,/report\.projects\.filter/);
  assert.match(app,/navigator\.maxTouchPoints>0/);
  assert.match(app,/active==="工卡扫描"\?" mobile-card-mode"/);
  assert.match(timekeepingCss,/\.sidebar \.nav-item\[data-nav="工卡扫描"\] \{ display: none; \}/);
  assert.match(timekeepingCss,/\.app-shell\.portable-device\.mobile-card-mode \.sidebar \{ display: none; \}/);
  assert.match(timekeepingCss,/\.app-shell\.portable-device\.mobile-card-mode \.workspace \{ width: 100%; margin-left: 0; \}/);
  assert.match(timekeepingCss,/\.time-card-scan-actions \{[^}]*grid-template-columns: repeat\(2,minmax\(0,1fr\)\);/s);
  assert.match(timekeepingCss,/\.time-card-scan-actions \.confirm \{[^}]*grid-column: 1\/-1;/s);
  assert.doesNotMatch(timekeepingCss,/\.time-card-scan-heading/);
  assert.match(timekeepingCss,/\.time-card-scan-actions button \{[^}]*min-height: 92px;/s);
  assert.match(timekeepingCss,/\.time-card-scan-identity strong \{[^}]*font-size: clamp\(34px,7vw,52px\);/s);
  assert.match(timekeepingCss,/\.time-employee-table \{[^}]*table-layout: fixed;/s);
  assert.match(timekeepingCss,/\.time-sort \{[^}]*grid-template-columns: minmax\(0,auto\) 12px;/s);
  assert.match(timekeepingCss,/\.time-confirm-button \{[^}]*width: calc\(100% - 40px\);/s);
  assert.match(timekeepingCss,/\.time-state\.interrupted \{[^}]*#ffe5e5;[^}]*#b42323;/s);
  assert.match(timekeepingCss,/\.time-employee-id-entry \{ -webkit-text-security: disc; \}/);
  assert.match(timekeepingCss,/\.time-scan-wave-select \{[^}]*border: 0;[^}]*color: #1e293b;[^}]*font-size: 15px;/s);
  assert.match(timekeepingCss,/\.time-wave-type > span \{[^}]*inset: 0;[^}]*line-height: 24px;[^}]*text-align: center;/s);
  assert.match(timekeepingCss,/\.time-scan-wave-table td:nth-child\(2\) \.time-wave-type,[^{]*\.time-dashboard-wave-table td:nth-child\(2\) \.time-wave-type \{ margin-inline: auto; \}/s);
  assert.match(timekeepingCss,/\.time-scan-wave-table td:nth-child\(2\) \.time-wave-type > span,[^{]*\.time-dashboard-wave-table td:nth-child\(2\) \.time-wave-type > span \{[^}]*margin-top: 0;[^}]*color: inherit;[^}]*font-size: 12px;/s);
  assert.match(timekeepingCss,/\.time-task-buttons \{[^}]*repeat\(5,minmax\(0,1fr\)\)/s);
  assert.match(timekeepingCss,/\.time-current-employee b \{[^}]*font-size: 32px;[^}]*font-weight: 900;/s);
  assert.match(timekeepingCss,/\.time-task-buttons b \{[^}]*font-size: 17px;/s);
  assert.match(timekeepingCss,/\.time-scan-wave-wrap \{[^}]*height: 917px;[^}]*overflow: auto;/s);
  assert.match(timekeepingCss,/\.time-scan-wave-table th \{[^}]*position: sticky;[^}]*top: 0;/s);
  assert.match(timekeepingCss,/\.time-task-buttons button\.current \{[^}]*animation: time-current-task-flow/s);
  assert.match(timekeepingCss,/\.time-scan-wave-table tbody tr\.current \{[^}]*animation: time-current-task-flow/s);
  assert.match(await read("app/api/v1/timekeeping/records/route.ts"),/access\.user\.role!=="admin"/);
  assert.match(recordsPage,/window\.setTimeout\(\(\)=>void load\(normalized\),420\)/);
  assert.match(recordsPage,/createPortal\(<div className="time-record-titlebar time-no-print"/);
  assert.doesNotMatch(recordsPage,/<div><b>扫描员工卡<\/b>|扫描后自动查询自然月记录|查询记录/);
  assert.match(recordsPage,/<b aria-live="polite">\{pending\?"识别中":"自动识别"\}<\/b>/);
  assert.doesNotMatch(`${scanPage}\n${recordsPage}`,/type="password"/);
  assert.match(recordsPage,/className="time-employee-id-entry" type="text"/);
  assert.doesNotMatch(recordsPage,/className="time-card time-record-lookup/);
  for(const label of ["自然月记录","当天处理内容","时间修改日志","导出整月数据","导出整月 PDF"]) {
    assert.match(recordsPage,new RegExp(label));
  }
  assert.match(recordsPage,/indexAttendancePairs\(report\.attendanceEvents\)/);
  assert.match(recordsPage,/const firstPair=pairs\[0\]/);
  assert.match(recordsPage,/const lastPair=pairs\.findLast\(pair=>pair\.signOut\)/);
  assert.match(recordsPage,/Array\.from\(\{length:6\}/);
  assert.match(recordsPage,/openWorkEditor\(row\.project!,"started_at"\)/);
  assert.match(recordsPage,/openWorkEditor\(row\.project!,"ended_at"\)/);
  assert.match(recordsPage,/className="time-monthly-print-report"/);
  assert.doesNotMatch(recordsPage,/员工ID|employee\.badgeCode,employee\.name/);
  const recordsRoute=await read("app/api/v1/timekeeping/records/route.ts");
  assert.match(recordsRoute,/access\.user\.role!=="admin"/);
  assert.match(recordsRoute,/target==="work_session"/);
  assert.match(recordsRoute,/工作时间必须完整位于对应的在岗时间内/);
  assert.match(recordsRoute,/该考勤时间会使已有工作记录落在不在岗区间/);
  const dashboardPage=await read("app/timekeeping/dashboard-page.tsx");
  const revisionRoute=await read("app/api/v1/timekeeping/revision/route.ts");
  assert.match(dashboardPage,/window\.setInterval\(\(\)=>setNow\(Date\.now\(\)\),1_000\)/);
  assert.match(dashboardPage,/liveElapsed\*item\.activeCount/);
  assert.match(dashboardPage,/person\.active\?liveElapsed:0/);
  assert.match(dashboardPage,/if-none-match/);
  assert.match(dashboardPage,/REVISION_POLL_MS=10_000/);
  assert.doesNotMatch(dashboardPage,/setInterval\([^)]*timeApi<DashboardResponse>/s);
  for(const label of ["波次数量","波次状态","未开启","当前","已完成","工作总时长","波次工时","工作汇总"]) {
    assert.match(dashboardPage,new RegExp(label));
  }
  assert.doesNotMatch(dashboardPage,/数据健康|anomalies|time-dashboard-health/);
  assert.doesNotMatch(dashboardPage,/>日常<|>当日员工<|员工ID/);
  assert.doesNotMatch(dashboardPage,/<Metric label="(?:扫描工时|其他工时)"/);
  assert.match(dashboardPage,/WaveStatusMetric total=\{waveKpis\.total\} unstarted=\{waveKpis\.unstarted\} current=\{waveKpis\.current\} completed=\{waveKpis\.completed\}/);
  assert.doesNotMatch(dashboardPage,/<Metric label="波次数量"/);
  assert.match(dashboardPage,/<small>波次数量 \{total\}<\/small>/);
  assert.match(dashboardPage,/EmployeeStatusMetric total=\{employeeKpis\.total\} picking=\{employeeKpis\.picking\} warehouse=\{employeeKpis\.warehouse\} standby=\{employeeKpis\.standby\}/);
  assert.match(dashboardPage,/员工统计/);
  assert.match(dashboardPage,/<small>员工总数 \{total\}<\/small>/);
  for(const label of ["拣货","仓务","待命"])assert.match(dashboardPage,new RegExp(`<small>${label}<\\/small>`));
  assert.match(dashboardPage,/const picking=totals\?\.waveActiveCount\?\?0/);
  assert.match(dashboardPage,/const warehouse=Math\.max\(0,\(totals\?\.activeCount\?\?0\)-picking\)/);
  assert.match(dashboardPage,/employee:participantOptions\(projects\)/);
  assert.match(dashboardPage,/employee:"员工"/);
  assert.match(dashboardPage,/!employeeFilterActive\|\|item\.participants\.some\(person=>!filters\.employee\.includes\(String\(person\.employeeId\)\)\)/);
  assert.match(app,/useState<DashboardFilters>\(\{channel:\[\],type:\[\],state:\[\],employee:\[\]\}\)/);
  assert.match(app,/dashboardFilters=\{timeDashboardFilters\} setDashboardFilters=\{setTimeDashboardFilters\}/);
  assert.match(dashboardPage,/className="time-dashboard-filter-reset"/);
  assert.match(dashboardPage,/setFilters\(\{channel:\[\],type:\[\],state:\[\],employee:\[\]\}\)/);
  assert.match(timekeepingCss,/\.time-status-metric i \{[^}]*height: 24px;[^}]*line-height: 24px;/s);
  assert.match(timekeepingCss,/\.time-dashboard-title-actions \{[^}]*justify-content: center;[^}]*margin-inline: auto;/s);
  assert.match(dashboardPage,/className="time-dashboard-main-grid"/);
  assert.doesNotMatch(dashboardPage,/EmployeeStatusList|time-dashboard-employee-stats/);
  assert.match(dashboardPage,/task\.participants\.map\(person=>/);
  assert.match(dashboardPage,/DailyTaskMetric task=\{task\}/);
  assert.match(dashboardPage,/className="time-daily-people-popover"/);
  assert.match(dashboardPage,/LeadSummary lead=\{lead\} helpers=\{helpers\}/);
  assert.match(dashboardPage,/onClick=\{\(\)=>openScan\(person\.badgeCode\)\}/);
  assert.match(dashboardPage,/openScan\?<button type="button" className=\{className\}/);
  assert.match(await read("app/timekeeping/timekeeping-module.tsx"),/closeImport=\{closeDashboardImport\} openScan=\{openScan\}/);
  assert.match(dashboardPage,/showDuration=\{false\}/);
  assert.doesNotMatch(dashboardPage,/<th>协同<\/th>/);
  assert.match(dashboardPage,/createPortal/);
  assert.match(dashboardPage,/role="tooltip"/);
  assert.match(dashboardPage,/onMouseEnter=\{cancelHide\} onMouseLeave=\{hide\}/);
  assert.match(timekeepingCss,/\.time-dashboard-helper-popover \{[^}]*pointer-events: auto;/s);
  assert.doesNotMatch(dashboardPage,/helpers\.slice\(0,2\)/);
  assert.match(dashboardPage,/RollingClock/);
  assert.match(dashboardPage,/const \[hours="0",minutes="00",seconds="00"\]=value\.split\(":"\)/);
  assert.match(timekeepingCss,/grid-template-columns: minmax\(1\.86em,max-content\)/);
  assert.match(timekeepingCss,/@keyframes time-clock-fade \{ from \{ opacity: \.35; \} to \{ opacity: 1; \} \}/);
  assert.doesNotMatch(timekeepingCss,/time-clock-roll|translateY\(-\.7em\)/);
  assert.match(dashboardPage,/item\.status==="completed"\?"completed":item\.interruptedAt\?"interrupted":undefined/);
  assert.match(dashboardPage,/disabled=\{pending\|\|item\.status==="completed"\}/);
  assert.match(dashboardPage,/className="interrupt"/);
  assert.match(dashboardPage,/mutate\(item,"interrupt"\)/);
  const waveDisplay=await read("app/timekeeping/wave-display.tsx");
  assert.match(waveDisplay,/WaveChannelTag/);
  assert.match(waveDisplay,/WaveTypeTag/);
  assert.match(waveDisplay,/>\{type\.short\}<\/span><\/span>/);
  for(const channel of ["usps","swiftx","gofo","cbt","cbs"])assert.match(waveDisplay,new RegExp(`${channel}:`));
  assert.match(dashboardPage,/downloadWorkbook/);
  for(const label of ["完结时间","每小时件数","导出筛选结果"])assert.match(dashboardPage,new RegExp(label));
  assert.match(dashboardPage,/waveHourlyPieces/);
  assert.match(dashboardPage,/visibleProjects\.map\(waveExportRow\)/);
  assert.match(dashboardPage,/startDate=\$\{exportStartDate\}&endDate=\$\{exportEndDate\}/);
  assert.match(dashboardPage,/const exportView=dashboardView\(exportData,Date\.now\(\)\)/);
  assert.match(dashboardPage,/const exportRows=exportView\.projects\.map\(waveExportRow\)/);
  assert.match(dashboardPage,/data\.range\.start/);
  const warehouseApp=await read("app/warehouse-app.tsx");
  assert.match(warehouseApp,/ref=\{setTimekeepingTitleTarget\}/);
  assert.match(warehouseApp,/titleTarget=\{timekeepingTitleTarget\}/);
  for(const label of ["当前波次","前一天","后一天","起始日期","终止日期","导出","导入波次"])assert.match(warehouseApp,new RegExp(label));
  assert.match(warehouseApp,/aria-label="导出日期范围"/);
  assert.match(warehouseApp,/value=\{timeDashboardExportStartDate\} max=\{timeDashboardExportEndDate\}/);
  assert.match(warehouseApp,/value=\{timeDashboardExportEndDate\} min=\{timeDashboardExportStartDate\}/);
  assert.match(warehouseApp,/dashboardDate=\{timeDashboardDate\} dashboardExportStartDate=\{timeDashboardExportStartDate\} dashboardExportEndDate=\{timeDashboardExportEndDate\}/);
  assert.doesNotMatch(warehouseApp,/setTimeDashboardDate\([^)]*timeDashboardExport/);
  const dashboardActionOrder=["setTimeDashboardImportOpen(true)","time-dashboard-current","addDays(date,-1)","addDays(date,1)","time-dashboard-date-range","time-dashboard-export"].map(value=>warehouseApp.indexOf(value));
  assert.ok(dashboardActionOrder.every((position,index)=>position>=0&&(index===0||position>dashboardActionOrder[index-1])),"现场看板操作顺序必须为导入、当前波次、前一天、后一天、导出日期范围、导出");
  for(const label of ["负责人","协同","导入当前波次","完结","中断","移除","全选","清空"])assert.match(dashboardPage,new RegExp(label));
  assert.match(dashboardPage,/disabled=\{pending\|\|!removable\}/);
  assert.match(dashboardPage,/formatDurationWithSeconds/);
  const dashboardRange=await read("lib/timekeeping/dashboard-range.ts");
  assert.match(dashboardRange,/dashboardRangeBounds\(requestedStartDate\?:string\|null,requestedEndDate\?:string\|null\)/);
  assert.match(dashboardRange,/if\(startDate>endDate\)\[startDate,endDate\]=\[endDate,startDate\]/);
  assert.match(dashboardRange,/start:localDateTimeToIso\(`\$\{startDate\}T00:00`\)/);
  assert.match(dashboardRange,/end:localDateTimeToIso\(`\$\{addDays\(endDate,1\)\}T00:00`\)/);
  assert.doesNotMatch(dashboardRange,/DASHBOARD_RANGES|startHour|endHour|00:00–08:00|16:00–24:00/);
  assert.match(timekeepingCss,/\.time-dashboard-wave-table \{ min-width: 800px; table-layout: fixed; \}/);
  assert.match(timekeepingCss,/\.time-dashboard-wave-table th,\.time-dashboard-wave-table td \{[^}]*padding: 3px 1px;/s);
  assert.doesNotMatch(dashboardPage,/今日现场看板/);
  assert.match(revisionRoute,/request\.headers\.get\("if-none-match"\)===etag/);
  assert.match(revisionRoute,/status:304/);
  assert.match(revisionRoute,/etag/);
  const readModel=await read("lib/timekeeping/read-model.ts");
  const timekeepingTypes=await read("app/timekeeping/types.ts");
  assert.match(readModel,/badgeCode:first\.badge_code/);
  assert.match(timekeepingTypes,/WorkParticipant=\{employeeId:number;badgeCode:string;/);
  assert.doesNotMatch(readModel,/anomalies|连续开工超过 14 小时/);
  assert.doesNotMatch(timekeepingTypes,/anomalies/);
  assert.match(readModel,/sessionDurationInRange/);
  assert.match(readModel,/work_date BETWEEN \$1 AND \$2/);
  assert.match(readModel,/timestampInRange\(item\.createdAt,rangeStart,rangeEnd\)/);
  assert.match(readModel,/toSorted\(\(left,right\)=>left\.sortOrder-right\.sortOrder\|\|left\.id-right\.id\)/);
  assert.match(readModel,/interruptedAt:toIsoOrNull\(item\.interrupted_at\)/);
  const testDataSeed=await read("scripts/seed-timekeeping-test-data.mjs");
  assert.match(testDataSeed,/historicalAttendance/);
  assert.match(testDataSeed,/threeSegments/);
  assert.match(testDataSeed,/shift_clock_in/);
  assert.match(testDataSeed,/sessions_outside_attendance/);
  assert.match(testDataSeed,/await replaceExistingTestData\(\)/);
  await assert.rejects(read("scripts/migrate-timekeeping-data.mjs"),error=>error?.code==="ENOENT");
});

test("serializes inventory mutations and records their revision atomically",async()=>{
  const inventoryWriters=[
    "app/api/v1/pallets/inbound/route.ts",
    "app/api/v1/pallets/[palletId]/route.ts",
    "app/api/v1/pallets/import/route.ts",
    "app/api/v1/tasks/route.ts",
    "app/api/v1/tasks/[taskId]/complete/route.ts",
    "app/api/v1/locations/route.ts",
    "app/api/v1/locations/[code]/route.ts",
    "app/api/v1/movements/route.ts",
  ];
  for(const path of inventoryWriters) {
    const source=await read(path);
    assert.match(source,/\.transaction\(async tx=>/s,`${path} must use a transaction`);
    assert.match(source,/lockWarehouseInventory\(tx\)/,`${path} must use the shared inventory lock`);
    assert.ok(source.includes("recordWarehouseRevision(tx)")||source.includes("tx.insert(warehouseRevisions)"),`${path} must record its revision in the transaction`);
  }

  const [claim,removeTask,users]=await Promise.all([
    read("app/api/v1/tasks/[taskId]/claim/route.ts"),
    read("app/api/v1/tasks/[taskId]/route.ts"),
    read("app/api/v1/users/[userId]/route.ts"),
  ]);
  for(const source of [claim,removeTask,users]) {
    assert.match(source,/\.transaction\(async tx=>/);
    assert.match(source,/recordWarehouseRevision\(tx\)/);
  }
  assert.match(users,/FOR UPDATE/);
  assert.equal((users.match(/pg_advisory_xact_lock\(7320250826\)/g)??[]).length,2);
  assert.match(users,/不能停用当前账号或取消自己的管理员角色/);
  assert.match(users,/系统必须保留至少一个有效管理员账号/);
  assert.match(users,/tx\.delete\(sessions\)/);
  assert.match(users,/deletedAt:new Date\(\)\.toISOString\(\)/);
  assert.match(users,/sourceOperatorUsername:sql`COALESCE/);
  assert.match(users,/await lockWarehouseInventory\(tx\)/);
});

test("preserves historical ledger source IDs, remarks and operators",async()=>{
  const [schema,runtime,api,app]=await Promise.all([
    read("db/schema.ts"),read("db/runtime.ts"),read("app/api/v1/movements/route.ts"),read("app/warehouse-app.tsx"),
  ]);
  assert.match(schema,/sourceRecordId: integer\("source_record_id"\)/);
  assert.match(schema,/remarks: text\("remarks"\)/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS source_record_id INTEGER/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS remarks TEXT/);
  assert.match(api,/sourceRecordId:row\.sourceId/);
  assert.match(api,/remarks:row\.remarks/);
  assert.match(api,/sourceOperatorUsername:row\.operatorUsername/);
  assert.match(api,/sourceFingerprint/);
  assert.match(api,/contentFingerprint/);
  assert.match(app,/movement\.sourceId\?\?movement\.id/);
  assert.doesNotMatch(api,/\{id:row\.sourceId/);
});

test("uses one ExcelJS implementation for all workbook downloads",async()=>{
  const [app,excel,packageText]=await Promise.all([read("app/warehouse-app.tsx"),read("lib/excel-workbook.ts"),read("package.json")]);
  const packageJson=JSON.parse(packageText);
  assert.equal(packageJson.dependencies.exceljs,"^4.4.0");
  assert.equal(packageJson.dependencies["bwip-js"],"^4.11.4");
  assert.equal(packageJson.dependencies.jszip,"^3.10.1");
  assert.equal(packageJson.dependencies.sharp,"^0.35.4");
  assert.equal(packageJson.dependencies.xlsx,undefined);
  assert.match(app,/async function downloadReserveWorkbook/);
  assert.match(app,/await downloadWorksheet\(\{/);
  assert.doesNotMatch(app,/zipWorkbook|crc32|columnName|TextEncoder|DataView/);
  assert.match(excel,/await downloadWorkbook\(\{fileName:input\.fileName,sheets:\[input\]\}\)/);
  assert.equal((excel.match(/new ExcelJS\.Workbook\(\)/g)??[]).length,3,"two readers and one writer should construct workbooks");
});

test("does not ship external backup integrations or credentials",async()=>{
  const paths=[
    "app/warehouse-app.tsx",".env.example","terraform/application-secrets.tf","terraform/iam.tf","terraform/outputs.tf",
  ];
  const shipped=(await Promise.all(paths.map(read))).join("\n");
  assert.doesNotMatch(shipped,/Google Drive|Google Apps|GOOGLE_APPS|BACKUP_SHARED|backup[_-]config|\/api\/v1\/backups/i);
  await Promise.all([
    assert.rejects(read("app/api/v1/backups/route.ts"),error=>error?.code==="ENOENT"),
    assert.rejects(read("lib/reserve-backup.ts"),error=>error?.code==="ENOENT"),
  ]);
});

test("keeps login responses generic and account passwords concealed",async()=>{
  const [loginRoute,loginForm,app]=await Promise.all([
    read("app/api/auth/login/route.ts"),read("app/login-form.tsx"),read("app/warehouse-app.tsx"),
  ]);
  assert.match(loginRoute,/user\?\.passwordSalt\?\?"invalid-login"/);
  assert.match(loginRoute,/账号或密码不正确/);
  assert.match(loginRoute,/httpOnly:true/);
  assert.match(loginRoute,/sameSite:"strict"/);
  assert.doesNotMatch(loginForm,/neiku2026|初始密码|管理员账号/);
  assert.match(app,/初始密码<input required type="password" autoComplete="new-password"/);
});

test("builds reserve SKU statistics from current reserve locations only",async()=>{
  const {buildReserveSkuStatistics}=await loadPure("reserve-statistics");
  const result=buildReserveSkuStatistics([
    {sku:"SKU-B",locationId:1},{sku:"sku-a",locationId:1},{sku:"SKU-B",locationId:2},
    {sku:"SKU-C",locationId:3},{sku:"SKU-D",locationId:null},{sku:"  ",locationId:1},
  ],[
    {id:1,type:"reserve"},{id:2,type:"reserve"},{id:3,type:"pick"},
  ]);
  assert.deepEqual(result,[{sku:"SKU-B",palletCount:2},{sku:"sku-a",palletCount:1}]);
});

test("ranks structured location searches without loose false matches",async()=>{
  const {findLocationMatches,normalizeLocationSearch}=await loadPure("location-search");
  const locations=["A-1-001","A-1-010","A-1-100","A-2-100","A-10-001","B-A-1-001"].map(code=>({code}));
  assert.equal(normalizeLocationSearch(" a_1 / 010 "),"A-1-010");
  assert.deepEqual(findLocationMatches(locations,"A-1-1").map(item=>item.code),["A-1-100"]);
  assert.deepEqual(findLocationMatches(locations,"A-1").map(item=>item.code),["A-1-001","A-1-010","A-1-100"]);
  assert.deepEqual(findLocationMatches(locations,"A1010").map(item=>item.code),["A-1-010"]);
  assert.deepEqual(findLocationMatches(locations,"Z-9"),[]);
});

test("normalizes stored timestamps and rejects nonexistent New York wall time",async()=>{
  const time=await loadPure("warehouse-time");
  assert.equal(time.normalizeStoredTimestamp("2026-01-02 03:04:05"),"2026-01-02T03:04:05Z");
  assert.equal(time.warehouseDateTimeInputToIso("2026-08-24T12:34:56"),"2026-08-24T16:34:56.000Z");
  assert.equal(time.formatWarehouseDateTimeFixed("2026-08-24T16:34:56Z"),"2026-08-24 12:34:56");
  assert.equal(time.warehouseDateKey("2026-08-24T03:30:00Z"),"2026-08-23");
  assert.throws(()=>time.warehouseDateTimeInputToIso("2026-03-08T02:30"),/不存在或处于夏令时切换区间/);
});

test("normalizes and validates typed location imports",async()=>{
  const locations=await loadPure("location-import");
  locations.validateLocationImportHeaders(["容量","类型","库位"]);
  assert.deepEqual(locations.normalizeLocationImportRow({"库位":" a-a-001 ","类型":"备货库位","容量":2},2),{
    code:"A-A-001",type:"reserve",capacity:2,sourceRow:2,
  });
  assert.deepEqual(locations.normalizeLocationImportRow({"库位":"A-A-001","类型":"主库位","容量":"1"},3),{
    code:"A-A-001",type:"pick",capacity:1,sourceRow:3,
  });
  assert.throws(()=>locations.normalizeLocationImportRow({"库位":"A","类型":"未知","容量":1},4),/类型无效/);
  assert.throws(()=>locations.validateUniqueLocationImportRows([
    {code:"A-A-001",type:"reserve",capacity:1,sourceRow:2},
    {code:"A-A-001",type:"reserve",capacity:2,sourceRow:5},
  ]),/第 5 行与第 2 行重复/);
});

test("normalizes only the five supported SKU catalog columns",async()=>{
  const catalog=await loadPure("sku-catalog");
  catalog.validateSkuCatalogHeaders(catalog.SKU_CATALOG_HEADERS);
  assert.deepEqual(catalog.normalizeSkuCatalogRow({
    "SKU":" abc-1 ",
    "Product Barcode(EAN/UPC)/产品条码 (EAN/UPC)":"123",
    "Client/客户":"客户 A","Product Name/产品名称":"Widget","Declared Chinese Name/申报中文名":"零件",
    "Dangerous Goods":"ignored",
  },8),{code:"ABC-1",barcode:"123",client:"客户 A",productName:"Widget",declaredChineseName:"零件",sourceRow:8});
  assert.equal(catalog.normalizeSkuCatalogRow({"SKU":" "},9),null);
  assert.throws(()=>catalog.validateSkuCatalogHeaders(["SKU"]),/缺少列/);
});

test("round-trips reserve inventory rows while ignoring exported empty slots",async()=>{
  const reserve=await loadPure("reserve-inventory-excel");
  reserve.validateReserveInventoryHeaders(reserve.RESERVE_INVENTORY_HEADERS);
  assert.equal(reserve.normalizeReserveInventoryRow({"库位":"A-1","托盘位":"2/4","状态":"空库位"},2),null);
  const source={
    "库位":" a-1 ","托盘位":"2/4","SKU":" sku-1 ","托盘号":" p-1 ","备注说明":"测试",
    "入库时间（美东）":"2026-08-24 12:30:00","状态":"在库",
  };
  const row=reserve.normalizeReserveInventoryRow(source,3);
  assert.deepEqual(row,{
    location:"A-1",slotIndex:2,slotCapacity:4,sku:"SKU-1",palletId:"P-1",remarks:"测试",
    inboundAt:"2026-08-24T16:30:00.000Z",status:"in_stock",sourceRow:3,
  });
  assert.throws(()=>reserve.validateReserveInventoryRows([row,{...row,sourceRow:6}]),/托盘号重复/);
  assert.throws(()=>reserve.normalizeReserveInventoryRow({...source,"托盘位":"5/4"},7),/托盘位格式无效/);
});

test("distinguishes ledger records by source ID, operator and historical remarks",async()=>{
  const ledger=await loadPure("warehouse-ledger-excel");
  ledger.validateWarehouseLedgerHeaders(ledger.WAREHOUSE_LEDGER_HEADERS);
  const source={
    "记录ID":41,"发生时间（美东）":"2026-08-24 12:30:00","动作":"手动调整","SKU":" sku-1 ","托盘号":" p-1 ",
    "起始库位":"a-1","起始库位类型":"备货库位","目标库位":"A-1","目标库位类型":"reserve",
    "备注说明":"历史备注","任务号":"TASK-1","操作账号":" Admin ","操作人":"管理员",
  };
  const row=ledger.normalizeWarehouseLedgerRow(source,2);
  assert.deepEqual(row,{
    sourceId:41,occurredAt:"2026-08-24T16:30:00.000Z",action:"adjust",sku:"SKU-1",palletId:"P-1",
    fromLocation:"A-1",fromLocationType:"reserve",toLocation:"A-1",toLocationType:"reserve",remarks:"历史备注",
    taskId:"TASK-1",operatorUsername:"admin",operatorName:"管理员",sourceRow:2,
  });
  const distinctSource={...row,sourceId:42,sourceRow:3};
  ledger.validateWarehouseLedgerRows([row,distinctSource]);
  assert.notEqual(ledger.warehouseLedgerFingerprint(row),ledger.warehouseLedgerFingerprint(distinctSource));
  assert.notEqual(ledger.warehouseLedgerFingerprint(row),ledger.warehouseLedgerFingerprint({...row,remarks:"另一备注"}));
  assert.notEqual(ledger.warehouseLedgerFingerprint(row),ledger.warehouseLedgerFingerprint({...row,operatorUsername:"other"}));
  assert.throws(()=>ledger.validateWarehouseLedgerRows([row,{...row,sourceRow:4}]),/记录ID重复/);
  assert.throws(()=>ledger.normalizeWarehouseLedgerRow({...source,"起始库位":"仓外","起始库位类型":"备货库位"},5),/不应填写起始库位类型/);
});

test("builds printable Letter task sheets with pagination and HTML escaping",async()=>{
  const {buildPrintDocument}=await loadPure("task-sheet-pdf");
  const rows=Array.from({length:10},(_,index)=>({sku:`SKU-${index}<x>`,fromLocation:"A&1",toLocation:"B-1",note:index===0?'"检查"':""}));
  const html=buildPrintDocument({taskId:"TASK<1>",type:"pick",rows});
  assert.equal((html.match(/class="sheet-page"/g)??[]).length,2);
  assert.match(html,/@page \{ size: Letter landscape/);
  assert.match(html,/页码：<strong>1 \/ 2<\/strong>/);
  assert.match(html,/全部取出[\s\S]*部分取出[\s\S]*退回备货/);
  assert.match(html,/TASK&lt;1&gt;/);
  assert.match(html,/SKU-0&lt;x&gt;/);
  assert.match(html,/A&amp;1/);
  assert.doesNotMatch(html,/TASK<1>|SKU-0<x>|A&1/);
});

test("ships a valid location template and no obsolete asset generator",async()=>{
  const template=await readFile(new URL("public/neiku-location-import-template.xlsx",root));
  assert.equal(template[0],0x50);
  assert.equal(template[1],0x4b);
  await assert.rejects(read("scripts/generate-task-sheet-assets.py"),error=>error?.code==="ENOENT");
});
