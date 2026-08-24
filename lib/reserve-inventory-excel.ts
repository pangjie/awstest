import { warehouseDateTimeInputToIso } from "./warehouse-time";

export const RESERVE_INVENTORY_SHEET = "备库总表";
export const RESERVE_INVENTORY_HEADERS = [
  "库位",
  "托盘位",
  "SKU",
  "托盘号",
  "备注说明",
  "入库时间（美东）",
  "库龄（天）",
  "状态",
] as const;
export const RESERVE_INVENTORY_IMPORT_MAX_ROWS = 10_000;

export type ReserveInventoryImportStatus = "in_stock" | "in_task";

export type NormalizedReserveInventoryRow = {
  location:string;
  slotIndex:number|null;
  slotCapacity:number|null;
  sku:string;
  palletId:string;
  remarks:string;
  inboundAt:string;
  status:ReserveInventoryImportStatus;
  sourceRow:number;
};

function textValue(value:unknown) {
  return value===null||value===undefined?"":String(value).trim();
}

export function validateReserveInventoryHeaders(headers:unknown[]) {
  const actual=headers.map(textValue);
  const missing=RESERVE_INVENTORY_HEADERS.filter(header=>!actual.includes(header));
  if(missing.length)throw new Error(`Excel 格式不符合要求，缺少列：${missing.join("、")}`);
}

export function normalizeReserveInventoryRow(row:Record<string,unknown>,sourceRow:number):NormalizedReserveInventoryRow|null {
  const location=textValue(row["库位"]).toUpperCase();
  const slotText=textValue(row["托盘位"]);
  const sku=textValue(row["SKU"]).toUpperCase();
  const palletId=textValue(row["托盘号"]).toUpperCase();
  const remarks=textValue(row["备注说明"]);
  const inboundValue=row["入库时间（美东）"];
  const inboundText=textValue(inboundValue);
  const rawStatus=textValue(row["状态"]).replace(/\s+/g,"").toLowerCase();

  // Exported empty pallet slots describe layout and must not delete inventory.
  if(!sku&&!palletId&&!remarks&&!inboundText)return null;
  if(!location)throw new Error(`第 ${sourceRow} 行缺少库位`);
  if(!sku)throw new Error(`第 ${sourceRow} 行缺少 SKU`);
  if(sku.length>120)throw new Error(`第 ${sourceRow} 行的 SKU 过长`);
  if(palletId.length>120)throw new Error(`第 ${sourceRow} 行的托盘号过长`);
  if(remarks.length>1_000)throw new Error(`第 ${sourceRow} 行的备注说明不能超过 1000 个字符`);
  if(!inboundText)throw new Error(`第 ${sourceRow} 行缺少入库时间（美东）`);

  let slotIndex:number|null=null,slotCapacity:number|null=null;
  if(slotText) {
    const match=slotText.match(/^(\d+)\s*\/\s*(\d+)$/);
    if(!match)throw new Error(`第 ${sourceRow} 行的托盘位格式无效，应为“序号/容量”，例如 1/2`);
    slotIndex=Number(match[1]);slotCapacity=Number(match[2]);
    if(!Number.isInteger(slotIndex)||!Number.isInteger(slotCapacity)||slotIndex<1||slotCapacity<1||slotIndex>slotCapacity) {
      throw new Error(`第 ${sourceRow} 行的托盘位格式无效`);
    }
  }

  let inboundAt="";
  try {
    inboundAt=normalizeReserveInboundAt(inboundValue);
  } catch {
    throw new Error(`第 ${sourceRow} 行的入库时间无效，请使用 YYYY-MM-DD HH:mm:ss（美东时间）`);
  }

  let status:ReserveInventoryImportStatus;
  if(!rawStatus||["在库","in_stock","instock","空库位","空托盘位","available"].includes(rawStatus))status="in_stock";
  else if(["作业中","in_task","intask"].includes(rawStatus))status="in_task";
  else throw new Error(`第 ${sourceRow} 行的状态无效，请填写“在库”或“作业中”`);

  return {location,slotIndex,slotCapacity,sku,palletId,remarks,inboundAt,status,sourceRow};
}

export function validateReserveInventoryRows(rows:NormalizedReserveInventoryRow[]) {
  if(!rows.length)throw new Error("Excel 中没有可导入的托盘库存记录");
  if(rows.length>RESERVE_INVENTORY_IMPORT_MAX_ROWS)throw new Error(`单次最多导入 ${RESERVE_INVENTORY_IMPORT_MAX_ROWS.toLocaleString()} 条托盘库存`);
  const palletRows=new Map<string,number>(),slotRows=new Map<string,number>();
  for(const row of rows) {
    if(row.palletId) {
      const first=palletRows.get(row.palletId);
      if(first!==undefined)throw new Error(`第 ${row.sourceRow} 行与第 ${first} 行的托盘号重复：${row.palletId}`);
      palletRows.set(row.palletId,row.sourceRow);
    }
    if(row.slotIndex!==null) {
      const key=`${row.location}:${row.slotIndex}`;
      const first=slotRows.get(key);
      if(first!==undefined)throw new Error(`第 ${row.sourceRow} 行与第 ${first} 行重复使用库位 ${row.location} 的第 ${row.slotIndex} 个托盘位`);
      slotRows.set(key,row.sourceRow);
    }
  }
}

function normalizeReserveInboundAt(value:unknown) {
  if(typeof value==="number"&&Number.isFinite(value)) {
    const milliseconds=Math.round(value*86_400_000);
    const date=new Date(Date.UTC(1899,11,30)+milliseconds);
    if(Number.isNaN(date.getTime()))throw new Error("invalid Excel date");
    const pad=(part:number)=>String(part).padStart(2,"0");
    return warehouseDateTimeInputToIso(`${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`);
  }
  const text=textValue(value).replace(/^(\d{4})\/(\d{2})\/(\d{2})/,"$1-$2-$3");
  return warehouseDateTimeInputToIso(text.replace(" ","T"));
}
