import { normalizeLocationImportType, type LocationImportType } from "./location-import";
import { warehouseDateTimeInputToIso } from "./warehouse-time";

export const WAREHOUSE_LEDGER_HISTORY_SHEET = "操作历史";
export const WAREHOUSE_LEDGER_IMPORT_MAX_ROWS = 10_000;
export const WAREHOUSE_LEDGER_HEADERS = [
  "记录ID",
  "发生时间（美东）",
  "动作",
  "SKU",
  "托盘号",
  "起始库位",
  "起始库位类型",
  "目标库位",
  "目标库位类型",
  "备注说明",
  "任务号",
  "操作账号",
  "操作人",
] as const;

export type LedgerAction = "inbound" | "pick" | "partial_pick" | "move" | "return" | "adjust";

export type NormalizedWarehouseLedgerRow = {
  sourceId:number|null;
  occurredAt:string;
  action:LedgerAction;
  sku:string;
  palletId:string;
  fromLocation:string;
  fromLocationType:LocationImportType|null;
  toLocation:string;
  toLocationType:LocationImportType|null;
  remarks:string;
  taskId:string;
  operatorUsername:string;
  operatorName:string;
  sourceRow:number;
};

const ACTION_ALIASES:Record<string,LedgerAction>={
  inbound:"inbound",pick:"pick",partial_pick:"partial_pick",move:"move",return:"return",adjust:"adjust",
  "存备货":"inbound","全部取出":"pick","取备货":"pick","部分取出":"partial_pick",
  "备货区迁移":"move","迁移备货":"move","退回备货区":"return","退回备货":"return","手动调整":"adjust",
};

function textValue(value:unknown) {
  return value===null||value===undefined?"":String(value).trim();
}

export function validateWarehouseLedgerHeaders(headers:unknown[]) {
  const actual=headers.map(textValue);
  const missing=WAREHOUSE_LEDGER_HEADERS.filter(header=>!actual.includes(header));
  if(missing.length)throw new Error(`Excel 格式不符合要求，缺少列：${missing.join("、")}`);
}

export function normalizeWarehouseLedgerRow(row:Record<string,unknown>,sourceRow:number):NormalizedWarehouseLedgerRow|null {
  const sourceIdText=textValue(row["记录ID"]);
  const occurredAtText=textValue(row["发生时间（美东）"]);
  const actionText=textValue(row["动作"]);
  const sku=textValue(row["SKU"]).toUpperCase();
  const palletId=textValue(row["托盘号"]).toUpperCase();
  const fromLocation=normalizeOutsideLocation(textValue(row["起始库位"]));
  const toLocation=normalizeOutsideLocation(textValue(row["目标库位"]));
  const taskId=textValue(row["任务号"]);
  const operatorUsername=textValue(row["操作账号"]).toLowerCase();
  const operatorName=textValue(row["操作人"]);
  const remarks=textValue(row["备注说明"]);
  if(!sourceIdText&&!occurredAtText&&!actionText&&!sku&&!palletId&&!fromLocation&&!toLocation&&!taskId&&!operatorUsername&&!operatorName&&!remarks)return null;

  let sourceId:number|null=null;
  if(sourceIdText) {
    const parsed=Number(sourceIdText);
    if(!Number.isInteger(parsed)||parsed<1)throw new Error(`第 ${sourceRow} 行的记录ID必须是正整数或留空`);
    sourceId=parsed;
  }
  if(!occurredAtText)throw new Error(`第 ${sourceRow} 行缺少发生时间（美东）`);
  let occurredAt="";
  try {
    occurredAt=warehouseDateTimeInputToIso(occurredAtText.replace(" ","T"));
  } catch {
    throw new Error(`第 ${sourceRow} 行的发生时间无效，请使用 YYYY-MM-DD HH:mm:ss`);
  }
  const action=ACTION_ALIASES[actionText.replace(/\s+/g,"").toLowerCase()];
  if(!action)throw new Error(`第 ${sourceRow} 行的动作无效`);
  if(!sku)throw new Error(`第 ${sourceRow} 行缺少 SKU`);
  if(!palletId)throw new Error(`第 ${sourceRow} 行缺少托盘号`);
  const fromLocationType=normalizeLedgerLocationType(row["起始库位类型"],fromLocation,sourceRow,"起始");
  const toLocationType=normalizeLedgerLocationType(row["目标库位类型"],toLocation,sourceRow,"目标");
  return {sourceId,occurredAt,action,sku,palletId,fromLocation,fromLocationType,toLocation,toLocationType,remarks,taskId,operatorUsername,operatorName,sourceRow};
}

export function validateWarehouseLedgerRows(rows:NormalizedWarehouseLedgerRow[]) {
  if(!rows.length)throw new Error("Excel 中没有可导入的操作历史");
  if(rows.length>WAREHOUSE_LEDGER_IMPORT_MAX_ROWS)throw new Error(`单次最多导入 ${WAREHOUSE_LEDGER_IMPORT_MAX_ROWS.toLocaleString()} 条操作历史`);
  const ids=new Map<number,number>();
  const fingerprints=new Map<string,number>();
  for(const row of rows) {
    if(row.sourceId!==null) {
      const first=ids.get(row.sourceId);
      if(first!==undefined)throw new Error(`第 ${row.sourceRow} 行与第 ${first} 行的记录ID重复`);
      ids.set(row.sourceId,row.sourceRow);
    }
    const fingerprint=warehouseLedgerFingerprint(row);
    const first=fingerprints.get(fingerprint);
    if(first!==undefined)throw new Error(`第 ${row.sourceRow} 行与第 ${first} 行是重复的操作记录`);
    fingerprints.set(fingerprint,row.sourceRow);
  }
}

export function warehouseLedgerFingerprint(row:Omit<NormalizedWarehouseLedgerRow,"sourceRow">) {
  return [row.sourceId??"",row.occurredAt,row.action,row.sku,row.palletId,row.fromLocation,row.fromLocationType??"",row.toLocation,row.toLocationType??"",
    row.taskId,row.operatorUsername,row.operatorName,row.remarks].join("\u001f");
}

function normalizeOutsideLocation(value:string) {
  const normalized=value.trim().toUpperCase();
  return ["仓外","出库","-","—"].includes(normalized)?"":normalized;
}

function normalizeLedgerLocationType(value:unknown,code:string,sourceRow:number,label:string):LocationImportType|null {
  const raw=textValue(value);
  if(!code) {
    if(raw)throw new Error(`第 ${sourceRow} 行没有${label}库位，不应填写${label}库位类型`);
    return null;
  }
  const type=normalizeLocationImportType(raw);
  if(!type)throw new Error(`第 ${sourceRow} 行的${label}库位类型无效`);
  return type;
}
