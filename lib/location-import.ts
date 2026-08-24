export const LOCATION_IMPORT_HEADERS = ["库位", "类型", "容量"] as const;

export const LOCATION_IMPORT_MAX_ROWS = 10000;

export type LocationImportType = "reserve" | "pick";

export type NormalizedLocationImportRow = {
  code:string;
  type:LocationImportType;
  capacity:number;
  sourceRow:number;
};

type LocationImportSourceRow = Record<string,unknown>;

function textValue(value:unknown) {
  return value===null||value===undefined?"":String(value).trim();
}

export function validateLocationImportHeaders(headers:unknown[]) {
  const actual=headers.map(value=>textValue(value));
  const missing=LOCATION_IMPORT_HEADERS.filter(header=>!actual.includes(header));
  if(missing.length)throw new Error(`Excel 格式不符合要求，缺少列：${missing.join("、")}`);
}

export function normalizeLocationImportType(value:unknown):LocationImportType|null {
  const normalized=textValue(value).replace(/\s+/g,"").toLowerCase();
  if(["reserve","备货","备货库位"].includes(normalized))return "reserve";
  if(["pick","拣货","拣货库位","主库位"].includes(normalized))return "pick";
  return null;
}

export function normalizeLocationImportRow(row:LocationImportSourceRow,sourceRow:number):NormalizedLocationImportRow|null {
  const code=textValue(row["库位"]).toUpperCase();
  const rawType=textValue(row["类型"]);
  const rawCapacity=textValue(row["容量"]);
  if(!code&&!rawType&&!rawCapacity)return null;
  if(!code)throw new Error(`第 ${sourceRow} 行缺少库位`);
  const type=normalizeLocationImportType(rawType);
  if(!type)throw new Error(`第 ${sourceRow} 行的类型无效，请填写“备货库位”或“拣货库位”`);
  const capacity=Number(rawCapacity);
  if(!Number.isInteger(capacity)||capacity<1||capacity>999)throw new Error(`第 ${sourceRow} 行的容量必须是 1–999 的整数`);
  return {code,type,capacity,sourceRow};
}

export function validateUniqueLocationImportRows(rows:NormalizedLocationImportRow[]) {
  if(!rows.length)throw new Error("Excel 中没有可导入的库位数据");
  if(rows.length>LOCATION_IMPORT_MAX_ROWS)throw new Error(`单次最多导入 ${LOCATION_IMPORT_MAX_ROWS.toLocaleString()} 个库位`);
  const firstRows=new Map<string,number>();
  for(const row of rows) {
    const key=`${row.type}:${row.code}`;
    const firstRow=firstRows.get(key);
    if(firstRow!==undefined)throw new Error(`第 ${row.sourceRow} 行与第 ${firstRow} 行重复：${row.code}（${row.type==="reserve"?"备货库位":"拣货库位"}）`);
    firstRows.set(key,row.sourceRow);
  }
}
