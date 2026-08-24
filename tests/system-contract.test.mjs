import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("uses internal accounts instead of ChatGPT authentication", async () => {
  const [login, auth, loginRoute, app] = await Promise.all([
    read("../app/login-form.tsx"),
    read("../lib/internal-auth.ts"),
    read("../app/api/auth/login/route.ts"),
    read("../app/warehouse-app.tsx"),
  ]);
  assert.match(login, /使用仓库内部账号继续/);
  assert.doesNotMatch(login, /neiku2026|初始密码|管理员账号/);
  assert.doesNotMatch(login, /signin-with-chatgpt|ChatGPT/i);
  assert.match(auth, /hashPassword/);
  assert.match(auth, /secureEqual/);
  assert.match(auth, /session/);
  assert.match(auth, /SESSION_MAX_AGE_SECONDS = 7 \* 24 \* 60 \* 60/);
  assert.match(auth, /SESSION_REFRESH_THRESHOLD_MS = 6 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(auth, /expiresAt:sessions\.expiresAt/);
  assert.match(auth, /update\(sessions\)\.set\(\{ expiresAt:refreshedExpiry\.toISOString\(\) \}\)/);
  assert.match(auth, /maxAge:SESSION_MAX_AGE_SECONDS/);
  assert.match(loginRoute, /Date\.now\(\)\+SESSION_MAX_AGE_SECONDS\*1000/);
  assert.match(loginRoute, /maxAge:SESSION_MAX_AGE_SECONDS/);
  assert.match(app, /function recoverExpiredSession\(\):Promise<never>/);
  assert.match(app, /void fetch\("\/api\/auth\/logout",\{method:"POST",cache:"no-store",keepalive:true\}\)\.catch/);
  assert.match(app, /window\.location\.replace\("\/\?session=expired"\)/);
  assert.doesNotMatch(app, /window\.location\.reload\(\)/);
});

test("recovers from stalled reads and stale deployed assets without reload loops", async () => {
  const [app,login,clientFetch,layout]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/login-form.tsx"),
    read("../lib/client-fetch.ts"),
    read("../app/layout.tsx"),
  ]);
  assert.match(clientFetch, /CLIENT_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(clientFetch, /controller\.abort\(\)/);
  assert.match(clientFetch, /服务器响应超时，请重新加载/);
  assert.match(app, /fetchWithTimeout\("\/api\/v1\/bootstrap"/);
  assert.match(app, /fetchWithTimeout\("\/api\/v1\/revision"/);
  assert.match(login, /fetchWithTimeout\("\/api\/auth\/login"/);
  assert.match(layout, /neiku_asset_reload_at/);
  assert.match(layout, /__neiku_reload/);
  assert.match(layout, /retryWindow=60000/);
  assert.match(layout, /sessionStorage\.removeItem\(key\)/);
});

test("keeps the production project free of starter and demo-data paths", async () => {
  const [packageJson,warehouseData,app,css]=await Promise.all([
    read("../package.json"),
    read("../lib/warehouse-data.ts"),
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
  ]);
  assert.match(packageJson, /"name": "aws-miniflow-neiku"/);
  assert.doesNotMatch(packageJson, /tailwindcss|site-creator-vinext-starter/);
  assert.doesNotMatch(warehouseData, /seedSkus|seedLocations|ensureWarehouseSeed|TK-0725/);
  assert.doesNotMatch(app, /compact=false|\bshown\b/);
  assert.doesNotMatch(css, /\.warning|\.pallet-picker|\.reserve-search-tools|\.timeline/);
  await Promise.all([
    assert.rejects(read("../public/file.svg"),error=>error?.code==="ENOENT"),
    assert.rejects(read("../examples/d1/db/schema.ts"),error=>error?.code==="ENOENT"),
  ]);
});

test("stores inbound pallets directly and keeps pick/move task-result inventory updates", async () => {
  const [warehouseData, inbound, createTask, completeTask, taskRepair] = await Promise.all([
    read("../lib/warehouse-data.ts"),
    read("../app/api/v1/pallets/inbound/route.ts"),
    read("../app/api/v1/tasks/route.ts"),
    read("../app/api/v1/tasks/[taskId]/complete/route.ts"),
    read("../app/api/v1/tasks/[taskId]/route.ts"),
  ]);
  assert.match(inbound, /SKU 和备货库位为必填项/);
  assert.match(inbound, /createPalletId/);
  assert.match(warehouseData, /warehouseDateKey\(date\)/);
  assert.match(warehouseData, /return `P\$\{dateStamp\}-\$\{String\(normalized\)\.padStart\(4,"0"\)\}`/);
  assert.doesNotMatch(warehouseData, /PLT-/);
  assert.match(inbound, /db\.transaction/);
  assert.match(inbound, /tx\.insert\(pallets\)/);
  assert.match(inbound, /tx\.insert\(movements\)/);
  assert.match(inbound, /requestedByTarget/);
  assert.match(inbound, /getLocationSlotUsage/);
  assert.match(createTask, /存备货为直接入库操作/);
  assert.match(createTask, /pickItems/);
  assert.match(createTask, /targetByPalletId/);
  assert.match(createTask, /moveItems/);
  assert.match(createTask, /requestedByTarget/);
  assert.match(createTask, /availableSlots/);
  assert.match(createTask, /db\.transaction/);
  assert.match(createTask, /tx\.update\(pallets\)/);
  assert.match(createTask, /inArray\(pallets\.id,palletIds\)/);
  assert.match(createTask, /claimed\.length!==palletIds\.length/);
  assert.match(createTask, /tx\.insert\(tasks\)/);
  assert.match(createTask, /tx\.insert\(taskItems\)\.values\(resolvedPallets\.map/);
  assert.doesNotMatch(createTask, /env\.DB|json_each/);
  assert.match(completeTask, /取备货任务必须逐托确认/);
  assert.match(completeTask, /item\.outcome!==null/);
  assert.match(completeTask, /allConfirmed/);
  assert.doesNotMatch(completeTask, /actualQuantities/);
  assert.match(completeTask, /"completed","returned","partial"/);
  assert.match(completeTask, /createPalletId/);
  assert.match(taskRepair, /requireAdmin/);
  assert.match(taskRepair, /NOT EXISTS \(SELECT 1 FROM.*taskItems/s);
  assert.match(taskRepair, /NOT EXISTS \(SELECT 1 FROM.*movements/s);
  assert.match(taskRepair, /系统拒绝删除/);
});

test("repairs orphaned in-task pallets once and keeps pallets with open task items locked", async () => {
  const runtime=await read("../db/runtime.ts");
  assert.match(runtime, /POSTGRES_RUNTIME_SCHEMA_VERSION=1001/);
  assert.match(runtime, /pg_advisory_lock/);
  assert.match(runtime, /client\.query\("BEGIN"\)/);
  assert.match(runtime, /UPDATE pallets AS pallet[\s\S]*SET status='in_stock'/);
  assert.match(runtime, /NOT EXISTS \([\s\S]*task_items item[\s\S]*JOIN tasks task/);
  assert.match(runtime, /item\.outcome IS NULL/);
  assert.match(runtime, /task\.status IN \('pending','claimed'\)/);
  assert.match(runtime, /repaired\.rowCount/);
  assert.match(runtime, /INSERT INTO warehouse_revisions/);
  assert.match(runtime, /client\.query\("COMMIT"\)/);
});

test("publishes searchable SKU, pallet, location and movement history APIs", async () => {
  const api = await read("../app/api/v1/route.ts");
  assert.match(api, /GET \/locations\/:code\/history/);
  assert.match(api, /locationIdentity: "库位由 code \+ type 共同唯一标识/);
  assert.match(api, /PATCH \/locations\/:code\?type=reserve\|pick/);
  assert.match(api, /GET \/skus\/:skuCode\/movements/);
  assert.match(api, /GET \/pallets\/:palletId\/movements/);
  assert.match(api, /GET \/movements\?/);
  assert.match(api, /DELETE \/tasks\/:taskId/);
});

test("merges SKU, location and operation ledgers into one warehouse ledger", async () => {
  const [app, enhancements, bootstrap] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/bootstrap/route.ts"),
  ]);
  assert.match(app, /const nav=\["工作台","备库总表","备货统计","SKU管理","库位管理","仓库台账","待办任务"\]/);
  assert.match(app, /active==="仓库台账"&&<WarehouseLedger/);
  assert.match(app, />SKU 台账<\/button>[\s\S]*>库位台账<\/button>[\s\S]*>操作历史<\/button>/);
  assert.match(app, /SKU 完整流转/);
  assert.match(app, /存备货[\s\S]*取备货[\s\S]*区内迁移/);
  assert.match(app, /库位完整历史/);
  assert.match(app, /移入记录[\s\S]*移出记录/);
  assert.match(app, /locationMovementDirection/);
  assert.match(app, /任务 \/ 操作人/);
  assert.match(app, /<th>备注说明<\/th>/);
  assert.match(app, /className=\{m\.remarks\?\.trim\(\)\?"ledger-remarks":"ledger-remarks empty"\}/);
  assert.doesNotMatch(app, /<th>数量<\/th>[\s\S]*m\.quantity/);
  assert.match(app, /开始日期[\s\S]*结束日期/);
  assert.match(bootstrap, /taskId:tasks\.id,operator:users\.name/);
  assert.match(enhancements, /\.ledger-master-detail\s*\{[^}]*grid-template-columns:\s*330px minmax\(0,\s*1fr\)/s);
});

test("uses one sortable reserve table with Excel export", async () => {
  const [app, enhancements] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /备库总表/);
  assert.match(app, /搜索 SKU/);
  assert.match(app, /精确搜索多个 SKU/);
  assert.match(app, /搜索库位/);
  assert.ok(app.indexOf('aria-label="搜索库位"') < app.indexOf('aria-label="搜索 SKU"'));
  assert.match(app, /const exactMatchCount=\(row:ReserveRow\)=>/);
  assert.match(app, /function parseExactSkuList\(value:string\)/);
  assert.match(app, /split\(\/\[,，;；\\r\\n\]\+\/\)/);
  assert.match(app, /exactSkuCodes\.has\(row\.pallet!\.sku\.toUpperCase\(\)\)/);
  assert.match(app, /精确 SKU \$\{exactSkuCodes\.size\} 个/);
  assert.match(app, /const invalidPriority=Number\(Boolean\(b\.pallet&&invalidSkuCodes\.has\(b\.pallet\.sku\)\)\)/);
  assert.ok(app.indexOf("const invalidPriority=") < app.indexOf("const relevance=exactMatchCount(b)-exactMatchCount(a)"));
  assert.match(app, /const relevance=exactMatchCount\(b\)-exactMatchCount\(a\)/);
  assert.match(app, /入库开始日期/);
  assert.match(app, /SortKey="location"\|"sku"\|"inboundAt"\|"ageDays"\|"status"/);
  assert.match(app, /"▲":"▼"/);
  assert.match(app, /:"▲▼"/);
  assert.match(app, /className="indexed-location table-location-header"[\s\S]*全选当前筛选结果[\s\S]*sortable\("location","库位"\)/);
  assert.doesNotMatch(app, /sortDirection==="asc"\?"↑":"↓"|:"↕"|SKU"\)\}<small> \/ 托盘号/);
  assert.match(app, /sortable\("status","状态"\)[\s\S]*className="pallet-column"/);
  assert.match(app, /className="pallet-column"[\s\S]*className="pallet-code"/);
  assert.doesNotMatch(app, /className="sku-code"[\s\S]{0,120}className="pallet-code"/);
  assert.match(enhancements, /\.sku-code\s*\{[^}]*font-size:\s*21px/s);
  assert.match(enhancements, /\.pallet-code\s*\{[^}]*font-size:\s*10px/s);
  assert.match(enhancements, /\.sort-button span\s*\{[^}]*width:\s*14px[^}]*min-width:\s*14px/s);
  assert.match(app, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(app, /\.xlsx/);
  assert.match(app, /rows\.map\(reserveRowSelectionKey\)/);
  assert.match(app, /选择空托盘位/);
  assert.match(app, /downloadReserveWorkbook\(selectedRows\)/);
  assert.match(app, /导出已选/);
  assert.doesNotMatch(app, /\/api\/v1\/backups|Google Drive|手动备份|backingUp|backupAll/);
  assert.doesNotMatch(enhancements, /manual-backup/);
  assert.match(app, /className="inventory-title-actions selection-toolbar"/);
  assert.match(app, /已选 <strong>\{selectedRows\.length\}<\/strong> 条记录/);
  assert.doesNotMatch(app, /导出筛选结果|downloadReserveWorkbook\(rows\)/);
  assert.doesNotMatch(app, /className="bulk-bar"/);
  assert.match(enhancements, /\.selection-toolbar\s*\{[^}]*background:\s*#edf3ff/s);
  assert.doesNotMatch(app, /高级筛选|导出 CSV|active==="库位"|active==="托盘库存"/);
});

test("does not ship external backup integrations", async () => {
  const [app,envExample,terraformSecrets,terraformIam,terraformOutputs]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../.env.example"),
    read("../terraform/application-secrets.tf"),
    read("../terraform/iam.tf"),
    read("../terraform/outputs.tf"),
  ]);
  const shippedConfiguration=[app,envExample,terraformSecrets,terraformIam,terraformOutputs].join("\n");
  assert.doesNotMatch(shippedConfiguration,/Google Drive|Google Apps|GOOGLE_APPS|BACKUP_SHARED|backup[_-]config|\/api\/v1\/backups/i);
  await Promise.all([
    assert.rejects(read("../app/api/v1/backups/route.ts"),error=>error?.code==="ENOENT"),
    assert.rejects(read("../app/api/v1/backups/export/route.ts"),error=>error?.code==="ENOENT"),
    assert.rejects(read("../lib/reserve-backup.ts"),error=>error?.code==="ENOENT"),
    assert.rejects(read("../lib/backup-config.ts"),error=>error?.code==="ENOENT"),
  ]);
});

test("tests dev and deploys main only after a merged pull request", async () => {
  const [ci,deploy]=await Promise.all([
    read("../.github/workflows/ci.yml"),
    read("../.github/workflows/deploy.yml"),
  ]);
  assert.match(ci,/pull_request:\n\s+branches: \[main\]/);
  assert.match(ci,/push:\n\s+branches: \[dev\]/);
  assert.match(deploy,/push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(deploy,/workflow_dispatch/);
  assert.match(deploy,/pull-requests: read/);
  assert.match(deploy,/commits\/\$\{GITHUB_SHA\}\/pulls/);
  assert.match(deploy,/select\(\.base\.ref == "main" and \.merged_at != null\)/);
  assert.ok(deploy.indexOf("Verify the revision came from a merged pull request") < deploy.indexOf("Configure short-lived AWS credentials"));
  assert.match(deploy,/environment: production/);
});

test("summarizes reserve pallets by SKU with descending counts and search", async () => {
  const [app, helper, enhancements] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../lib/reserve-statistics.ts"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /active==="备货统计"&&<ReserveStatistics/);
  assert.match(app, /aria-label="搜索备货统计 SKU"/);
  assert.match(app, /默认按托数从高到低排列/);
  assert.match(app, /托盘数 ▼/);
  assert.match(app, /invalidSkuCodes\.has\(row\.sku\)\?"statistics-sku invalid-sku"/);
  assert.match(helper, /location\.type === "reserve"/);
  assert.match(helper, /b\.palletCount - a\.palletCount/);
  assert.match(helper, /a\.sku\.localeCompare\(b\.sku/);
  assert.match(enhancements, /\.statistics-pallet-count\s*\{[^}]*font-size:\s*25px/s);
});

test("counts only pallets currently assigned to reserve locations", async () => {
  const {buildReserveSkuStatistics}=await import("../lib/reserve-statistics.ts");
  const result=buildReserveSkuStatistics([
    {sku:"SKU-B",locationId:1},
    {sku:"SKU-A",locationId:1},
    {sku:"SKU-B",locationId:2},
    {sku:"SKU-C",locationId:3},
    {sku:"SKU-D",locationId:null},
  ],[
    {id:1,type:"reserve"},
    {id:2,type:"reserve"},
    {id:3,type:"pick"},
  ]);
  assert.deepEqual(result,[
    {sku:"SKU-B",palletCount:2},
    {sku:"SKU-A",palletCount:1},
  ]);
});

test("uses a compact wide direct-putaway form with only SKU and location required", async () => {
  const [app, css, inbound] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
    read("../app/api/v1/pallets/inbound/route.ts"),
  ]);
  assert.match(app, /api\/v1\/pallets\/inbound/);
  assert.match(app, /可先添加多行再统一填写/);
  assert.match(app, /storeMissingSku/);
  assert.match(app, /请填写每一行的 SKU 后再存入备货区/);
  assert.match(app, /存入备货区/);
  assert.match(app, /target:""/);
  assert.match(app, /<option value="">选择库位<\/option>/);
  assert.match(app, /storeRows\.length>=targetSlots\.length/);
  assert.match(app, /storeAtCapacity/);
  assert.match(app, /备货库位已满，无法继续添加/);
  assert.match(app, /备注说明选填/);
  assert.match(app, /aria-label=\{`备注说明 \$\{index\+1\}`\}/);
  assert.match(inbound, /remarks:\[[\s\S]*item\.remarks\?\.trim\(\)/);
  assert.doesNotMatch(app, /storeRows\.length>=50/);
  assert.doesNotMatch(app, /商品名称|初始数量/);
  assert.doesNotMatch(app, />直接存入</);
  assert.match(app, /modal-card-wide/);
  assert.doesNotMatch(app, /整托货物/);
  assert.match(css, /\.store-grid-head/);
  assert.match(css, /\.remove-store-line/);
});

test("merges legacy product name and initial quantity into pallet remarks", async () => {
  const [app, schema, runtime, migration, inbound, palletUpdate, bootstrap, createTask, readModel] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../app/api/v1/pallets/inbound/route.ts"),
    read("../app/api/v1/pallets/[palletId]/route.ts"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../app/api/v1/tasks/route.ts"),
    read("../lib/warehouse-read-model.ts"),
  ]);
  assert.match(schema, /remarks: text\("remarks"\)\.notNull\(\)\.default\(""\)/);
  assert.doesNotMatch(schema, /initialQuantity: integer\("initial_quantity"\)/);
  assert.doesNotMatch(schema, /export const skus = pgTable\("skus", \{[\s\S]*?\n\s+name: text\("name"\)/);
  assert.match(runtime, /remarks TEXT NOT NULL DEFAULT ''/);
  assert.doesNotMatch(runtime, /DROP COLUMN|ALTER TABLE pallets/);
  assert.match(migration, /"remarks" text DEFAULT '' NOT NULL/);
  assert.doesNotMatch(migration, /initial_quantity|DROP COLUMN/);
  assert.match(inbound, /tx\.insert\(pallets\)\.values/);
  assert.doesNotMatch(inbound, /initial_quantity/);
  assert.match(palletUpdate, /remarks,inboundAt,updatedAt/);
  assert.match(bootstrap, /remarks:pallets\.remarks/);
  assert.match(readModel, /palletRemarks:pallets\.remarks/);
  assert.doesNotMatch(bootstrap, /name:skus\.name|initialQuantity:pallets\.initialQuantity|skuName:skus\.name/);
  assert.match(createTask, /plannedQuantity:0,returnedQuantity:0/);
  assert.match(app, /<th>备注说明<\/th>/);
  assert.match(app, /pallet\?\.remarks/);
  assert.match(app, /\["库位","托盘位","SKU","托盘号","备注说明","入库时间（美东）"/);
  assert.doesNotMatch(app, /商品名称|初始数量/);
});

test("supports multi-row SKU-driven pick tasks with browser-printable black-and-white US Letter sheets", async () => {
  const [app, enhancements, createTask, pdf, assetScript] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/tasks/route.ts"),
    read("../lib/task-sheet-pdf.ts"),
    read("../scripts/generate-task-sheet-assets.py"),
  ]);
  assert.match(app, /const \[pickRows,setPickRows\]/);
  assert.match(app, /id="pick-sku-options"/);
  assert.match(app, /list="pick-sku-options"/);
  assert.match(app, /const targetOptionsId=`pick-target-options-\$\{row\.key\}`/);
  assert.match(app, /findLocationMatches\(targets,row\.target,100\)/);
  assert.match(app, /list=\{targetOptionsId\}/);
  assert.match(app, /<datalist id=\{targetOptionsId\}>/);
  assert.doesNotMatch(app, /function PickSearchCombobox/);
  assert.match(app, /validPickTargetCodes\.has\(row\.target\.trim\(\)\.toUpperCase\(\)\)/);
  assert.doesNotMatch(app, /目标拣货库位/);
  assert.match(app, /每行先输入 SKU，再选择该 SKU 的备货库位和主库位/);
  assert.match(app, /备货库位 \/ 托盘/);
  assert.match(app, /主库位/);
  assert.match(app, /添加一条取备货/);
  assert.match(app, /pickItems:pickRows\.map/);
  assert.match(app, /打印PDF作业单/);
  assert.doesNotMatch(app, /下载 PDF 作业单|下载PDF作业单/);
  assert.match(app, /printWarehouseTaskSheet/);
  assert.match(pdf, /export async function printWarehouseTaskSheet/);
  assert.match(pdf, /printWindow\.print\(\)/);
  assert.match(pdf, /@page \{ size: Letter landscape; margin: 0\.35in 0\.4in; \}/);
  assert.match(pdf, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) auto/);
  assert.match(pdf, /<th>作业结果<\/th>/);
  assert.match(pdf, /"主库位"/);
  assert.match(pdf, /全部取出[\s\S]*部分取出[\s\S]*退回备货/);
  assert.match(pdf, /border: 1\.25pt solid #000/);
  assert.match(pdf, /td\.sku \{ font-size: 18pt/);
  assert.match(pdf, /td\.location \{ font-size: 17pt/);
  assert.match(pdf, /th \{[^}]*font-size: 14pt/s);
  assert.match(pdf, /\.choice \{[^}]*font-size: 11pt/s);
  assert.doesNotMatch(pdf, /createObjectURL|link\.download|buildLetterPdf|task-sheet-.*\.jpg|#3568d4|#17243a|#66758a|#e8eef8/i);
  assert.match(pdf, /const ROWS_PER_PAGE = 9/);
  assert.match(assetScript, /HEADERS = \("SKU", "备货库位", "主库位", "作业结果", "备注"\)/);
  assert.match(assetScript, /landscape\(letter\)/);
  assert.match(assetScript, /\("全部取出", "部分取出", "退回备货"\)/);
  assert.doesNotMatch(`${pdf}\n${assetScript}`, /目标拣货库位|是否完成|任务状态|执行要求|完成时间|复核人|复核时间|托盘号|计划数量/);
  assert.match(createTask, /pickItems\?:Array<\{palletId:string;toLocationCode:string;note\?:string\}>/);
  assert.match(createTask, /new Set\(palletIds\)\.size!==palletIds\.length/);
  assert.match(createTask, /targetByPalletId\.get\(p\.id\)/);
  assert.match(enhancements, /\.pick-grid-head,[\s\S]*\.pick-line\s*\{[^}]*grid-template-columns:/s);
  assert.doesNotMatch(enhancements, /\.pick-search-matches/);
  assert.match(enhancements, /\.modal-actions \.pick-pdf-action/);
});

test("shows and confirms each pick pallet independently without entering a quantity", async () => {
  const [app, enhancements, completeTask, bootstrap, schema, runtime, subtaskTimeMigration, locationHistory, readModel] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/tasks/[taskId]/complete/route.ts"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../app/api/v1/locations/[code]/history/route.ts"),
    read("../lib/warehouse-read-model.ts"),
  ]);
  assert.doesNotMatch(app, /多个起始库位|起始位置|逐托分配库位/);
  assert.match(app, /className="pick-task-items"/);
  assert.match(app, /<dt>SKU<\/dt><dd className=\{row\.sku&&invalidSkuCodes\.has\(row\.sku\)/);
  assert.match(app, /<dt>备货库位<\/dt>/);
  assert.match(app, /<dt>主库位<\/dt>/);
  assert.match(app, /托盘号：\{row\.palletId\}/);
  assert.match(app, /className="pick-subtask-summary"><span>SKU：<b className=\{row\.sku&&invalidSkuCodes\.has\(row\.sku\)/);
  assert.match(app, /function groupTasks\(tasks:Task\[\]\):TaskGroup\[\]/);
  assert.match(app, /className="task-subtask-summaries"/);
  assert.match(app, /<ul className="task-subtask-summaries">\{rows\.map\(\(row,index\)=><li key=\{row\.palletId\?\?index\}><span className="task-summary-part">SKU：<b/);
  assert.match(app, /const lines=tasks\.flatMap\(group=>group\.rows\.map\(\(row,index\)=>\(\{task:row,index,total:group\.rows\.length\}\)\)\)/);
  assert.match(app, /const pendingGroups=tasks\.filter\(group=>group\.rows\.some\(row=>taskItemResult\(row\)\.key==="pending"\)\)/);
  assert.match(app, />待处理 <span>\{pendingGroups\.length\}<\/span><\/button>/);
  assert.match(app, />全部 <span>\{lines\.length\}<\/span><\/button>/);
  assert.doesNotMatch(app, /\[\["open","待处理"\],\["completed","已完成"\],\["partial","部分完成"\],\["returned","已退回"\],\["all","全部"\]\]/);
  assert.match(app, /tab==="open"\?<div className="task-list">\{pendingGroups\.length\?pendingGroups\.map\(group=><TaskRow/);
  assert.match(app, /function TaskSubtaskRow/);
  assert.match(app, /className="task-subtask-row"/);
  assert.match(app, /<span>作业结果<\/span><span>操作<\/span>/);
  assert.match(app, /return \{key:"pending",label:"待处理"\}/);
  assert.match(app, /task\.type==="pick"\?"全部取出"/);
  assert.match(app, /task\.type==="pick"\?"部分取出"/);
  assert.match(app, /label:"退回备货"/);
  assert.doesNotMatch(app, /\{r\.plannedQuantity\} 箱/);
  assert.match(app, /className="pick-complete"[\s\S]*:"全部取出"/);
  assert.match(app, /className="pick-partial"[\s\S]*>部分取出<\/button>/);
  assert.match(app, /className="pick-return"[\s\S]*>退回库位<\/button>/);
  assert.doesNotMatch(app, />确认(?:全部取出|部分取出|退回库位)<\/button>/);
  assert.doesNotMatch(app, /取出数量|部分取出数量/);
  assert.match(app, /JSON\.stringify\(\{palletId:row\.palletId,outcome/);
  assert.match(app, /pickItemOutcome\(row\)/);
  assert.match(completeTask, /if\(!body\.palletId\)/);
  assert.match(completeTask, /items\.find\(row=>row\.palletId===body\.palletId\)/);
  assert.match(completeTask, /updatedItems\.every\(row=>row\.outcome!==null\)/);
  assert.match(completeTask, /action:"partial_pick"/);
  assert.match(completeTask, /status:"in_stock",locationId:item\.fromLocationId/);
  assert.match(completeTask, /const nowIso=now\.toISOString\(\)/);
  assert.match(completeTask, /resolvedAt:nowIso/);
  assert.doesNotMatch(completeTask, /\.set\(\{quantity:/);
  assert.match(readModel, /returnedQuantity:taskItems\.returnedQuantity/);
  assert.match(readModel, /itemOutcome:taskItems\.outcome/);
  assert.match(readModel, /itemResolvedAt:taskItems\.resolvedAt/);
  assert.match(bootstrap, /const completedToday=recentlyResolvedRows\.filter\(row=>row\.resolvedAt&&warehouseDateKey\(row\.resolvedAt\)===today\)\.length/);
  assert.doesNotMatch(bootstrap, /new Set\(taskRows\.filter\(t=>t\.status==="completed"/);
  assert.match(app, /label="今日已处理托盘" value=\{String\(stats\.completedToday\)\} unit="托" note="今日已确认作业结果" color="violet"/);
  assert.doesNotMatch(app, /label="今日已完成"|note="已处理托盘"/);
  assert.match(schema, /remarks: text\("remarks"\)\.notNull\(\)/);
  assert.match(schema, /resolvedAt: utcTimestamp\("resolved_at"\)/);
  assert.match(schema, /"inbound","pick","partial_pick","move","return","adjust"/);
  assert.match(runtime, /resolved_at TIMESTAMPTZ/);
  assert.match(subtaskTimeMigration, /"resolved_at" timestamp with time zone/);
  assert.match(locationHistory, /row\.action==="partial_pick"/);
  assert.match(enhancements, /\.pick-task-route\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(enhancements, /\.pick-subtask-summary\s*\{/);
  assert.match(enhancements, /\.task-subtask-summaries\s*\{/);
  assert.match(enhancements, /\.task-subtask-summaries\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(enhancements, /\.task-main \.task-subtask-summaries li\s*\{[^}]*display:\s*block[^}]*width:\s*100%/s);
  assert.match(enhancements, /\.task-line-head,[\s\S]*\.task-subtask-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:/s);
  assert.match(enhancements, /\.task-line-result\.pending\s*\{/);
  assert.match(enhancements, /\.task-line-sku\s*\{[^}]*font-size:\s*20px/s);
  assert.match(enhancements, /\.task-line-location\s*\{[^}]*font-size:\s*18px/s);
  assert.match(enhancements, /\.pick-item-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(enhancements, /\.pick-item-actions \.pick-complete\s*\{[^}]*background:\s*#f1faf6/s);
  assert.match(enhancements, /\.pick-item-actions \.pick-partial\s*\{[^}]*background:\s*#fff8e3/s);
  assert.match(enhancements, /\.pick-item-actions \.pick-return\s*\{[^}]*background:\s*#fff2f2/s);
  assert.doesNotMatch(enhancements, /\.pick-partial-action/);
});

test("ranks segmented pick-location searches without loose browser matching", async () => {
  const {findLocationMatches,normalizeLocationSearch}=await import("../lib/location-search.ts");
  const locations=[
    {code:"A-1-001"},
    {code:"A-1-010"},
    {code:"A-1-100"},
    {code:"A-2-100"},
    {code:"A-10-001"},
    {code:"B-A-1-001"},
  ];
  assert.equal(normalizeLocationSearch(" a_1 / 010 "),"A-1-010");
  assert.deepEqual(findLocationMatches(locations,"A-1-1").map(item=>item.code),["A-1-100"]);
  assert.deepEqual(findLocationMatches(locations,"A-1").map(item=>item.code),["A-1-001","A-1-010","A-1-100"]);
  assert.deepEqual(findLocationMatches(locations,"A1010").map(item=>item.code),["A-1-010"]);
  assert.deepEqual(findLocationMatches(locations,"A-1-010").map(item=>item.code)[0],"A-1-010");
  assert.deepEqual(findLocationMatches(locations,"Z-9"),[]);
});

test("uses the same multi-row workflow for reserve-to-reserve moves", async () => {
  const [app, enhancements, createTask] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/tasks/route.ts"),
  ]);
  assert.match(app, /const \[moveRows,setMoveRows\]/);
  assert.match(app, /BATCH MOVE TASK/);
  assert.match(app, /id="move-sku-options"/);
  assert.match(app, /每行先输入 SKU，再选择该 SKU 当前所在的备货库位和托盘/);
  assert.match(app, /当前备货库位 \/ 托盘/);
  assert.match(app, /目标备货空位/);
  assert.match(app, /location\.code!==sourcePallet\?\.location/);
  assert.match(app, /targetHasRoom\(location\.code,otherTargets\)/);
  assert.match(app, /添加一条迁移备货/);
  assert.match(app, /moveItems:moveRows\.map/);
  assert.match(app, /type:"move",rows:sheetRows/);
  assert.doesNotMatch(app, /className="pallet-picker"/);
  assert.match(createTask, /requestedByTarget/);
  assert.match(createTask, /availableSlots<requested\.count/);
  assert.match(enhancements, /\.move-guidance\s*\{[^}]*background:\s*#fff9ee/s);
  assert.match(enhancements, /\.move-add-line\s*\{[^}]*color:\s*#ad741e/s);
});

test("keeps the three warehouse flows as the dashboard primary actions", async () => {
  const [app, css] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
  ]);
  assert.doesNotMatch(app, /新建待办/);
  assert.match(app, /aria-label="备货核心操作"/);
  assert.match(app, /core-action store-action/);
  assert.match(app, /core-action pick-action/);
  assert.match(app, /core-action move-action/);
  assert.match(css, /\.quick-actions\{[^}]*width:100%;max-width:none/);
  assert.match(css, /\.quick-actions button\{[^}]*height:104px/);
  assert.match(css, /\.quick-actions \.qa\{[^}]*width:58px;height:58px/);
  assert.match(css, /\.quick-actions b\{[^}]*font-size:22px;font-weight:850/);
  assert.doesNotMatch(css, /\.quick-actions\{display:none\}/);
});

test("aligns the three dashboard metric cards to one shared structure", async () => {
  const [app,enhancements]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /<Metric label="备货库存"[\s\S]*note="当前有效托盘"/);
  assert.match(app, /<Metric label="托盘位占用"[\s\S]*note=\{`\$\{stats\.occupied\} \/ \$\{stats\.reserveCapacity\} 托盘位`\}/);
  assert.match(app, /<Metric label="今日已处理托盘"[\s\S]*note="今日已确认作业结果"/);
  assert.match(app, /<h3><strong>\{value\}<\/strong><span>\{unit\}<\/span><\/h3><small>\{note\}<\/small>/);
  assert.doesNotMatch(app, /progress=\{occupancy\}|mini-progress/);
  assert.match(enhancements, /\.dashboard-metric-grid \.metric\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*44px minmax\(0,\s*1fr\)/s);
  assert.match(enhancements, /\.dashboard-metric-grid \.metric-copy\s*\{[^}]*grid-template-rows:\s*22px 38px 20px/s);
  assert.match(enhancements, /\.dashboard-metric-grid \.metric-copy h3\s*\{[^}]*align-items:\s*baseline/s);
  assert.match(app, /className="dashboard-overview-grid"/);
  assert.match(enhancements, /\.dashboard-overview-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(220px, 1fr\)\)/s);
  assert.match(enhancements, /\.dashboard-overview-grid \.dashboard-metric-grid\s*\{[^}]*grid-column:\s*1[^}]*height:\s*364px/s);
  assert.match(enhancements, /\.dashboard-overview-grid \.tasks-panel\s*\{[^}]*grid-column:\s*2 \/ 4[^}]*height:\s*364px/s);
  assert.match(enhancements, /\.dashboard-overview-grid \.tasks-panel \.task-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(app, /库位概览/);
});

test("moves the date into the sidebar and removes the dashboard header", async () => {
  const [app, css, enhancements] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.doesNotMatch(app, /aria-label="待办通知"|className="bell"/);
  assert.match(app, /className="brand"[\s\S]*className="sidebar-date"[\s\S]*<nav>/);
  assert.match(app, /active!=="工作台"&&<header>/);
  assert.doesNotMatch(app, /仓库数据已同步|className="pulse"|今日仓况|早上好/);
  assert.match(enhancements, /\.sidebar-date\s*\{[^}]*grid-template-columns:\s*1fr auto/s);
  assert.match(enhancements, /\.sidebar-date time strong\s*\{[^}]*font-size:\s*18px/s);
  assert.match(css, /body\{[^}]*font-size:17px/);
  assert.doesNotMatch(css, /font-size:(?:7|8|9|10|11)px/);
});

test("shows recent operation history at the bottom of the dashboard", async () => {
  const [app,time] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../lib/warehouse-time.ts"),
  ]);
  assert.match(app, /<h3>最近操作历史<\/h3>/);
  assert.match(app, /new Set\(\[warehouseDateKey\(now\),previousWarehouseDateKey\(now\)\]\)/);
  assert.match(app, /data\.movements\.filter\(movement=>recentDateKeys\.has\(warehouseDateKey\(movement\.occurredAt\)\)\)/);
  assert.match(app, /包含今日及前一天的全部操作记录/);
  assert.match(app, /<LedgerMovementTable rows=\{recentMovements\} invalidSkuCodes=\{invalidSkuCodes\}\/>/);
  assert.doesNotMatch(app, /data\.movements\.slice\(0,8\)/);
  assert.match(time, /export function previousWarehouseDateKey/);
  assert.match(app, /setLedgerEntry\(\{tab:"history",query:""\}\);setActive\("仓库台账"\)/);
  assert.doesNotMatch(app, /<ReserveTable pallets=\{data\.pallets\} locations=\{data\.locations\} compact/);
});

test("stores one optional note on every pick subtask", async () => {
  const [app,createTask,readModel,schema,runtime,migration,pdf,enhancements]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/tasks/route.ts"),
    read("../lib/warehouse-read-model.ts"),
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../lib/task-sheet-pdf.ts"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /aria-label=\{`取备货子任务备注 \$\{index\+1\}`\}/);
  assert.match(app, /note:row\.note\.trim\(\)/);
  assert.match(app, /子任务备注：\{row\.itemNote\}/);
  assert.match(app, /note:row\.itemNote\?\?""/);
  assert.match(createTask, /noteByPalletId/);
  assert.match(createTask, /note:body\.type==="pick"/);
  assert.match(readModel, /itemNote:taskItems\.note/);
  assert.match(schema, /note: text\("note"\),[\s\S]*outcome: text\("outcome"/);
  assert.match(runtime, /note TEXT,[\s\S]*outcome TEXT/);
  assert.match(migration, /"note" text,[\s\S]*"outcome" text/);
  assert.match(pdf, /escapeOptionalHtml\(row\.note\)/);
  assert.match(enhancements, /\.pick-line \.pick-line-note\s*\{[^}]*grid-column:\s*1 \/ -1/s);
});

test("keeps core dashboard geometry stable in Safari", async () => {
  const [app,css]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
  ]);
  assert.match(app, /window\.scrollTo\(\{top:0,left:0,behavior:"auto"\}\)/);
  assert.match(css, /\.donut\{position:relative;isolation:isolate;flex:0 0 116px;overflow:hidden\}/);
  assert.match(css, /\.donut::before\{inset:19px;width:auto;height:auto;z-index:0\}/);
  assert.match(css, /\.donut>div\{z-index:1\}/);
  assert.match(css, /\.legend\{min-width:0;flex:1 1 auto\}/);
  assert.match(css, /-webkit-backdrop-filter:blur\(3px\)/);
});

test("uses a focused narrow-screen layout for mobile warehouse work", async () => {
  const [app,enhancements]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /const narrowHiddenNav=new Set<\(typeof nav\)\[number\]>\(\["SKU管理","库位管理","仓库台账"\]\)/);
  assert.match(app, /window\.matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(app, /data-nav=\{n\}/);
  assert.match(app, /className="workspace" data-page=\{active\}/);
  assert.match(app, /className="task-summary-part">SKU：/);
  assert.match(app, /className="task-line-field-label">备货库位 \/ 起始库位/);
  assert.match(app, /className="task-line-field-label">主库位 \/ 目标库位/);
  assert.match(enhancements, /\/\* Narrow-screen warehouse mode \*\//);
  assert.match(enhancements, /\.brand,\s*\.sidebar-date\s*\{\s*display:\s*none/s);
  assert.match(enhancements, /data-nav="SKU管理"[\s\S]*data-nav="库位管理"[\s\S]*data-nav="仓库台账"[\s\S]*display:\s*none/);
  assert.match(enhancements, /\.dashboard-history\s*\{\s*display:\s*none/s);
  assert.match(enhancements, /\.pick-line\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(enhancements, /\.reserve-table \.inventory-title,[\s\S]*\.reserve-table \.reserve-filter-panel\s*\{\s*display:\s*none/s);
  assert.match(enhancements, /\.reserve-table th:nth-child\(n\+3\),[\s\S]*display:\s*none/);
  assert.match(enhancements, /\.reserve-statistics-table\s*\{[^}]*min-width:\s*0/s);
  assert.match(enhancements, /\.task-summary-part,[\s\S]*\.pick-subtask-summary > span\s*\{\s*display:\s*block/s);
  assert.match(enhancements, /\.task-line-head\s*\{\s*display:\s*none/s);
  assert.match(enhancements, /\.task-subtask-row\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
});

test("uses Eastern time consistently and orders history by real timestamps", async () => {
  const [app, time, runtime, bootstrap, movementsApi, locationHistory, completeTask, pdf, enhancements] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    import("../lib/warehouse-time.ts"),
    read("../db/runtime.ts"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../app/api/v1/movements/route.ts"),
    read("../app/api/v1/locations/[code]/history/route.ts"),
    read("../app/api/v1/tasks/[taskId]/complete/route.ts"),
    read("../lib/task-sheet-pdf.ts"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.equal(time.normalizeStoredTimestamp("2026-07-28 16:00:00"),"2026-07-28T16:00:00Z");
  assert.match(time.formatWarehouseTime("2026-07-28T16:00:00Z",{hour:"2-digit",minute:"2-digit",hour12:false}),/12:00/);
  assert.match(time.formatWarehouseTime("2026-01-28T16:00:00Z",{hour:"2-digit",minute:"2-digit",hour12:false}),/11:00/);
  assert.equal(time.warehouseDateKey("2026-07-29T02:00:00Z"),"2026-07-28");
  assert.equal(time.warehouseDateTimeInputToIso("2026-07-28T12:00"),"2026-07-28T16:00:00.000Z");
  assert.equal(time.warehouseDateTimeInputToIso("2026-01-28T12:00"),"2026-01-28T17:00:00.000Z");
  assert.equal(time.formatWarehouseDateTimeFixed("2026-07-28T21:07:04Z"),"2026-07-28 17:07:04");
  assert.match(runtime, /occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  assert.doesNotMatch(runtime, /strftime|julianday/);
  assert.match(bootstrap, /orderBy\(desc\(movements\.occurredAt\),desc\(movements\.id\)\)/);
  assert.match(movementsApi, /orderBy\(desc\(movements\.occurredAt\),desc\(movements\.id\)\)/);
  assert.match(locationHistory, /orderBy\(asc\(movements\.occurredAt\),asc\(movements\.id\)\)/);
  assert.match(app, /movements:sortMovementsNewestFirst\(body\.data\.movements\)/);
  assert.match(app, /<th>时间（美东）<\/th>/);
  assert.match(app, /function formatLedgerTime\(value:string\)\{return formatWarehouseDateTimeFixed\(value\)\}/);
  assert.match(app, /入库时间（美东）/);
  assert.match(completeTask, /occurredAt:nowIso/);
  assert.match(pdf, /日期（美东）/);
  assert.match(enhancements, /\.ledger-action\.action-pick,[\s\S]*?\{[^}]*#fdebed/s);
  assert.match(enhancements, /\.ledger-action\.action-partial_pick\s*\{[^}]*#fff4d8/s);
  assert.match(enhancements, /\.ledger-table td time\s*\{[^}]*width:\s*19ch[^}]*font-family:[^}]*monospace[^}]*white-space:\s*nowrap/s);
});

test("removes inventory age warnings while retaining ordinary age display and sorting", async () => {
  const [app, css, enhancements, bootstrap] = await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/globals.css"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/bootstrap/route.ts"),
  ]);
  assert.doesNotMatch(app, /库龄预警|ageWarnings|age danger|mini-ring/);
  assert.doesNotMatch(bootstrap, /ageWarnings|Number\(p\.ageDays\)>=14/);
  assert.doesNotMatch(css, /\.metric-icon\.amber|\.metric-copy \.amber|\.mini-ring|\.age\.danger/);
  assert.match(app, /sortable\("ageDays","库龄"\)/);
  assert.match(app, /<span className="age">\{pallet\.ageDays\} 天<\/span>/);
  assert.match(app, /metric-grid dashboard-metric-grid/);
  assert.match(enhancements, /\.dashboard-metric-grid\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
});

test("supports capacity-aware location management and manual inventory editing", async () => {
  const [schema, runtime, migration, warehouseData, locationsApi, locationUpdate, palletUpdate, taskComplete, bootstrap, app, enhancements] = await Promise.all([
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../lib/warehouse-data.ts"),
    read("../app/api/v1/locations/route.ts"),
    read("../app/api/v1/locations/[code]/route.ts"),
    read("../app/api/v1/pallets/[palletId]/route.ts"),
    read("../app/api/v1/tasks/[taskId]/complete/route.ts"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(schema, /capacity: integer\("capacity"\)\.notNull\(\)\.default\(1\)/);
  assert.match(schema, /uniqueIndex\("locations_code_type_unique"\)\.on\(t\.code,t\.type\)/);
  assert.doesNotMatch(schema, /code: text\("code"\)\.notNull\(\)\.unique\(\),\n  type:/);
  assert.match(runtime, /capacity INTEGER NOT NULL DEFAULT 1 CHECK \(capacity BETWEEN 1 AND 999\)/);
  assert.match(runtime, /CREATE UNIQUE INDEX IF NOT EXISTS locations_code_type_unique/);
  assert.match(runtime, /schemaInitialization\?\?=initializeRuntimeSchema\(\)\.catch/);
  assert.match(migration, /CREATE UNIQUE INDEX "locations_code_type_unique" ON "locations" USING btree \("code","type"\)/);
  assert.match(warehouseData, /getLocationByCode\(code:string,type:"reserve"\|"pick"\)/);
  assert.match(locationsApi, /export async function POST/);
  assert.match(locationsApi, /and\(eq\(locations\.code,code\),eq\(locations\.type,type\)\)/);
  assert.match(locationUpdate, /export async function PATCH/);
  assert.match(locationUpdate, /searchParams\.get\("type"\)/);
  assert.match(locationUpdate, /capacity<palletCount/);
  assert.match(schema, /status: text\("status", \{ enum:\["available","occupied"\] \}\)/);
  assert.match(app, /<option value="available">空托盘位<\/option><\/select>/);
  assert.match(palletUpdate, /action:"adjust"/);
  assert.match(palletUpdate, /getLocationSlotUsage/);
  assert.match(taskComplete, /occupiedAfterCompletion>usage\.capacity/);
  assert.match(app, /"库位管理"/);
  assert.match(app, /function LocationManagement/);
  assert.match(app, /function InventoryEditModal/);
  assert.match(app, /flatMap\(location=>/);
  assert.match(app, /slotIndex:index\+1/);
  assert.match(app, /reserve-filter-panel/);
  assert.match(app, /role="tablist" aria-label="库位类型"/);
  assert.match(app, /<span>备货库位<\/span><b>\{counts\.reserve\}<\/b>/);
  assert.match(app, /<span>拣货库位<\/span><b>\{counts\.pick\}<\/b>/);
  assert.match(app, /location\.type===viewType/);
  assert.match(app, /const pageSize=100/);
  assert.match(app, /\?type=\$\{draft\.originalType\}/);
  assert.match(bootstrap, /fromLocationType:sql<"reserve"\|"pick"\|null>`fl\.type`/);
  assert.match(bootstrap, /toLocationType:sql<"reserve"\|"pick"\|null>`tl\.type`/);
  assert.match(enhancements, /\.reserve-table \.location-link[\s\S]*font-size: 19px/);
  assert.match(enhancements, /\.reserve-table td \.sku-code\s*\{[^}]*font-size: 21px/);
  assert.match(enhancements, /\.reserve-table td \.pallet-code\s*\{[^}]*font-size: 10px/);
  assert.match(enhancements, /\.location-type-tabs\s*\{[^}]*display:\s*flex/s);
  assert.match(enhancements, /\.location-type-badge\.pick\s*\{[^}]*color:\s*#16875f/s);
});

test("imports and manages the five-column WMS SKU catalog while flagging unknown inventory", async () => {
  const [packageJson,schema,runtime,migration,helper,api,bootstrap,app,enhancements,apiIndex]=await Promise.all([
    read("../package.json"),
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../lib/sku-catalog.ts"),
    read("../app/api/v1/sku-catalog/route.ts"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
    read("../app/api/v1/route.ts"),
  ]);
  assert.match(packageJson, /"exceljs": "\^4\.4\.0"/);
  assert.doesNotMatch(packageJson, /"xlsx"/);
  assert.match(schema, /export const skuCatalog = pgTable\("sku_catalog"/);
  assert.match(schema, /declaredChineseName: text\("declared_chinese_name"\)/);
  assert.doesNotMatch(schema, /sku_external_id|dangerous_goods_type|raw_data/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS sku_catalog/);
  assert.match(runtime, /declared_chinese_name TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /CREATE TABLE "sku_catalog"/);
  assert.match(migration, /"declared_chinese_name" text DEFAULT '' NOT NULL/);
  assert.match(helper, /SKU_CATALOG_HEADERS/);
  assert.match(helper, /Product Barcode\(EAN\/UPC\)\/产品条码 \(EAN\/UPC\)/);
  assert.match(helper, /Declared Chinese Name\/申报中文名/);
  assert.doesNotMatch(helper, /SKU ID|FNSKU|Dangerous Goods/);
  assert.match(app, /readFirstWorksheet\(await file\.arrayBuffer\(\)\)/);
  assert.match(app, /validateSkuCatalogHeaders/);
  assert.match(app, /normalized\.length;index\+=1000/);
  assert.match(api, /body\.action==="start"/);
  assert.match(api, /body\.action==="batch"/);
  assert.match(api, /body\.action==="finish"/);
  assert.match(api, /getPool\(\)\.connect\(\)/);
  assert.match(api, /DELETE FROM sku_catalog WHERE import_key=\$1 AND active=FALSE/);
  assert.match(api, /CASE WHEN UPPER\(\$\{skuCatalog\.code\}\)=\$\{q\.toUpperCase\(\)\} THEN 0 ELSE 1 END/);
  assert.match(apiIndex, /POST \/sku-catalog/);
  assert.match(bootstrap, /invalidSkuCodes:invalidSkuRows\.map\(row=>row\.code\)/);
  assert.match(bootstrap, /NOT EXISTS \([\s\S]*FROM \$\{skuCatalog\}/);
  assert.match(app, /active==="SKU管理"&&<SkuManagement/);
  assert.match(app, /function SkuManagement/);
  assert.match(app, /导入 SKU 数据/);
  assert.match(app, /只提取 SKU、产品条码、客户、产品名称、申报中文名/);
  assert.match(app, /<th>SKU<\/th><th>产品条码<\/th><th>客户<\/th><th>产品名称<\/th><th>申报中文名<\/th>/);
  assert.doesNotMatch(app, /SkuCatalogDetails|SKU ID<\/th>|FNSKU<\/th>|危险品类型<\/th>/);
  assert.match(app, /invalidSkuCodes\.has\(pallet\.sku\)\?"sku-code invalid-sku"/);
  assert.match(enhancements, /\.invalid-sku\s*\{[^}]*#c93642/s);
});

test("exports reserve statistics in the displayed ranking order", async () => {
  const [app,enhancements]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(app, /onClick=\{\(\)=>downloadReserveStatisticsWorkbook\(rows\)\}/);
  assert.match(app, /\["排名","SKU","备货托数"\]/);
  assert.match(app, /rows\.map\(\(row,index\)=>\[index\+1,row\.sku,row\.palletCount\]\)/);
  assert.match(app, /内库备货统计-/);
  assert.match(enhancements, /\.statistics-export-button\s*\{/);
});

test("adds new SKU catalog records and updates existing records without deleting missing SKUs", async () => {
  const [app,api]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/sku-catalog/route.ts"),
  ]);
  assert.match(api, /COUNT\(DISTINCT UPPER\(code\)\) AS uniqueCodes/);
  assert.match(api, /SELECT MAX\(id\) AS id FROM sku_catalog WHERE import_key=\$1 GROUP BY UPPER\(code\)/);
  assert.match(api, /NOT EXISTS \([\s\S]*existing\.active=TRUE AND UPPER\(existing\.code\)=UPPER\(staged\.code\)/);
  assert.match(api, /UPDATE sku_catalog AS existing SET[\s\S]*code=winner\.code[\s\S]*barcode=winner\.barcode[\s\S]*client=winner\.client[\s\S]*product_name=winner\.product_name[\s\S]*declared_chinese_name=winner\.declared_chinese_name[\s\S]*source_row=winner\.source_row[\s\S]*import_key=winner\.import_key[\s\S]*imported_at=winner\.imported_at/);
  assert.match(api, /WHERE existing\.active=TRUE AND UPPER\(existing\.code\)=UPPER\(winner\.code\)/);
  assert.match(api, /WHERE id=ANY\(\$1::int\[\]\)/);
  assert.match(api, /DELETE FROM sku_catalog WHERE import_key=\$1 AND active=FALSE/);
  assert.match(api, /duplicateCodes:importedRows-uniqueCodes/);
  assert.match(api, /addedCodes:candidateIds\.length,updatedCodes:uniqueCodes-candidateIds\.length/);
  assert.doesNotMatch(api, /UPDATE sku_catalog SET active=FALSE WHERE active=TRUE/);
  assert.match(app, /新增系统中尚不存在的 SKU，并用新文件中的信息覆盖已有同名 SKU/);
  assert.match(app, /文件中未出现的旧 SKU 会保留/);
  assert.match(app, /同一文件内重复的 SKU 以最后一条记录为准/);
  assert.match(app, /已更新 \$\{result\.updatedCodes\.toLocaleString\(\)\} 个已有 SKU/);
  assert.match(app, /条文件内重复记录已按最后一条处理/);
  assert.doesNotMatch(app, /重新导入会替换上次导入的清单|已有 SKU 已跳过/);
});

test("manually creates SKU catalog records while rejecting duplicate SKU codes", async () => {
  const [app,api,apiIndex,enhancements]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/sku-catalog/route.ts"),
    read("../app/api/v1/route.ts"),
    read("../app/warehouse-enhancements.css"),
  ]);
  assert.match(api, /body\.action==="create"/);
  assert.match(api, /eq\(skuCatalog\.active,true\)/);
  assert.match(api, /UPPER\(\$\{skuCatalog\.code\}\)=\$\{code\}/);
  assert.match(api, /\(error as \{code\?:string\}\)\.code==="23505"/);
  assert.match(api, /SKU \$\{code\} 已存在，请勿重复添加/);
  assert.match(api, /status:409/);
  assert.match(api, /importKey=`manual:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(apiIndex, /action=create/);
  assert.match(app, /手动添加 SKU/);
  assert.match(app, /postSkuCatalogCreate/);
  assert.match(app, /SKU 为必填项，系统会忽略大小写校验重复/);
  assert.match(app, /文件中未出现的旧 SKU 会保留/);
  assert.match(enhancements, /\.sku-manual-form\s*\{/);
});

test("bulk imports typed locations from the three-column Excel template", async () => {
  const [app,api,apiIndex,helper,enhancements,template]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/locations/route.ts"),
    read("../app/api/v1/route.ts"),
    read("../lib/location-import.ts"),
    read("../app/warehouse-enhancements.css"),
    readFile(new URL("../public/neiku-location-import-template.xlsx",import.meta.url)),
  ]);
  assert.match(helper, /LOCATION_IMPORT_HEADERS = \["库位", "类型", "容量"\]/);
  assert.match(helper, /"备货库位"\]\.includes\(normalized\)\)return "reserve"/);
  assert.match(helper, /"拣货库位","主库位"\]\.includes\(normalized\)\)return "pick"/);
  assert.match(helper, /第 \$\{row\.sourceRow\} 行与第 \$\{firstRow\} 行重复/);
  assert.match(app, /validateLocationImportHeaders/);
  assert.match(app, /validateUniqueLocationImportRows/);
  assert.match(app, /href="\/neiku-location-import-template\.xlsx" download="内库库位导入模板\.xlsx"/);
  assert.match(app, /批量导入库位/);
  assert.match(api, /body\.action==="import"/);
  assert.match(api, /onConflictDoUpdate/);
  assert.match(api, /target:\[locations\.code,locations\.type\]/);
  assert.match(api, /set:\{capacity:sql`excluded\.capacity`,zone:sql`excluded\.zone`\}/);
  assert.match(api, /当前占用 \$\{capacityConflict\.palletCount\} 托/);
  assert.match(apiIndex, /action=import/);
  assert.match(enhancements, /\.location-import-button\s*\{/);
  assert.equal(template[0],0x50);
  assert.equal(template[1],0x4b);

  const {normalizeLocationImportRow,validateUniqueLocationImportRows}=await import("../lib/location-import.ts");
  assert.deepEqual(normalizeLocationImportRow({"库位":" a-a-001 ","类型":"备货库位","容量":2},2),{code:"A-A-001",type:"reserve",capacity:2,sourceRow:2});
  assert.deepEqual(normalizeLocationImportRow({"库位":"A-A-001","类型":"拣货库位","容量":"1"},3),{code:"A-A-001",type:"pick",capacity:1,sourceRow:3});
  assert.throws(()=>validateUniqueLocationImportRows([
    {code:"A-A-001",type:"reserve",capacity:1,sourceRow:2},
    {code:"A-A-001",type:"reserve",capacity:2,sourceRow:5},
  ]),/第 5 行与第 2 行重复/);
});

test("keeps multiple open clients fresh with low-cost revision polling and basic conflict guards", async () => {
  const [schema,runtime,migration,revisionHelper,revisionApi,apiIndex,app,taskCreate,taskClaim,taskComplete,...writers]=await Promise.all([
    read("../db/schema.ts"),
    read("../db/runtime.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
    read("../lib/warehouse-revision.ts"),
    read("../app/api/v1/revision/route.ts"),
    read("../app/api/v1/route.ts"),
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/tasks/route.ts"),
    read("../app/api/v1/tasks/[taskId]/claim/route.ts"),
    read("../app/api/v1/tasks/[taskId]/complete/route.ts"),
    read("../app/api/v1/pallets/inbound/route.ts"),
    read("../app/api/v1/pallets/[palletId]/route.ts"),
    read("../app/api/v1/locations/route.ts"),
    read("../app/api/v1/locations/[code]/route.ts"),
    read("../app/api/v1/sku-catalog/route.ts"),
    read("../app/api/v1/users/route.ts"),
    read("../app/api/v1/users/[userId]/route.ts"),
  ]);
  assert.match(schema,/warehouseRevisions = pgTable\("warehouse_revisions"/);
  assert.match(runtime,/CREATE TABLE IF NOT EXISTS warehouse_revisions/);
  assert.match(migration,/CREATE TABLE "warehouse_revisions"/);
  assert.match(revisionHelper,/getDb\(\)\.insert\(warehouseRevisions\)/);
  assert.match(revisionHelper,/orderBy\(desc\(warehouseRevisions\.id\)\)\.limit\(1\)/);
  assert.match(revisionApi,/getInternalUser/);
  assert.match(revisionApi,/cache-control":"no-store/);
  assert.match(apiIndex,/GET \/revision/);
  assert.match(app,/fetchWithTimeout\("\/api\/v1\/revision",\{cache:"no-store"\}\)/);
  assert.match(app,/window\.setInterval\(\(\)=>void syncIfChanged\(\),10000\)/);
  assert.match(app,/document\.visibilityState!=="visible"/);
  assert.match(app,/window\.addEventListener\("focus",onFocus\)/);
  assert.match(app,/window\.addEventListener\("online",onFocus\)/);
  assert.match(app,/document\.addEventListener\("visibilitychange",onVisibility\)/);
  assert.match(app,/if\(revision===revisionRef\.current\)return/);
  assert.match(app,/setExternalSyncKey\(value=>value\+1\)/);
  assert.match(app,/\[q,page,refreshKey,externalRefreshKey\]/);
  assert.match(app,/已同步其他设备的最新操作/);
  for(const writer of writers)assert.match(writer,/recordWarehouseRevision\(\)/);

  assert.match(taskCreate,/eq\(pallets\.status,"in_stock"\)/);
  assert.match(taskCreate,/returning\(\{id:pallets\.id\}\)/);
  assert.match(taskCreate,/部分托盘已被其他设备加入任务/);
  assert.match(taskClaim,/eq\(tasks\.status,"pending"\)/);
  assert.match(taskClaim,/任务已被其他设备领取或处理/);
  assert.match(taskComplete,/isNull\(taskItems\.outcome\)/);
  assert.match(taskComplete,/该托盘已被其他设备确认/);
  assert.match(taskComplete,/inArray\(tasks\.status,\["pending","claimed"\]\)/);
});

test("loads only core warehouse data first and defers complete histories", async () => {
  const [app,bootstrap,tasksApi,movementsApi,readModel,runtime,schema,migration]=await Promise.all([
    read("../app/warehouse-app.tsx"),
    read("../app/api/v1/bootstrap/route.ts"),
    read("../app/api/v1/tasks/route.ts"),
    read("../app/api/v1/movements/route.ts"),
    read("../lib/warehouse-read-model.ts"),
    read("../db/runtime.ts"),
    read("../db/schema.ts"),
    read("../drizzle/0000_bent_bruce_banner.sql"),
  ]);
  assert.match(bootstrap,/getTaskDetailRows\("pending"\)/);
  assert.match(bootstrap,/from\(locations\)\.where\(eq\(locations\.type,"reserve"\)\)/);
  assert.match(bootstrap,/\.where\(gte\(movements\.occurredAt,recentStart\)\)/);
  assert.match(bootstrap,/await Promise\.all\(\[/);
  assert.match(bootstrap,/invalidSkuCodes:invalidSkuRows\.map\(row=>row\.code\),revision/);
  assert.match(app,/void fetchWarehouseData\(\)[\s\S]*revisionRef\.current=nextData\.revision/);
  assert.doesNotMatch(app,/const revision=await fetchWarehouseRevision\(\)\.catch/);
  assert.match(app,/fetchAllMovementHistory/);
  assert.match(app,/active!=="仓库台账"/);
  assert.match(app,/fetchAllTaskDetails/);
  assert.match(app,/active!=="待办任务"/);
  assert.match(app,/fetchPickLocations/);
  assert.match(app,/modal==="pick"\|\|active==="库位管理"\|\|active==="仓库台账"/);
  assert.match(app,/api\/v1\/locations\?type=pick&compact=1/);
  assert.match(app,/api\/v1\/movements\?limit=1000&offset=/);
  assert.match(tasksApi,/searchParams\.get\("detail"\)==="1"/);
  assert.match(tasksApi,/getTaskDetailRows\("all"\)/);
  assert.match(readModel,/scope==="pending"\?inArray\(tasks\.status,\["pending","claimed"\]\)/);
  assert.match(movementsApi,/Math\.min\(1000/);
  assert.match(runtime,/pg_advisory_lock/);
  assert.match(runtime,/ON CONFLICT\(id\) DO UPDATE SET version=EXCLUDED\.version/);
  assert.match(schema,/runtimeSchemaState = pgTable\("runtime_schema_state"/);
  assert.match(migration,/CREATE INDEX "movements_time_idx"/);
  assert.match(migration,/CREATE INDEX "task_items_task_idx"/);
});
