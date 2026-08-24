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
  "sku-catalog","task-sheet-pdf","warehouse-ledger-excel","warehouse-time",
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
  assert.match(runtime,/POSTGRES_RUNTIME_SCHEMA_VERSION=1003/);
  assert.match(runtime,/pg_advisory_lock/);
  assert.match(runtime,/client\.query\("BEGIN"\)/);
  assert.match(runtime,/CREATE TABLE IF NOT EXISTS/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS source_record_id INTEGER/);
  assert.match(runtime,/ADD COLUMN IF NOT EXISTS remarks TEXT/);
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
