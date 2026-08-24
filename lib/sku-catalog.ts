export const SKU_CATALOG_HEADERS = [
  "SKU",
  "Product Barcode(EAN/UPC)/产品条码 (EAN/UPC)",
  "Client/客户",
  "Product Name/产品名称",
  "Declared Chinese Name/申报中文名",
] as const;

export type SkuCatalogSourceRow = Record<string, unknown>;

export type NormalizedSkuCatalogRow = {
  code:string;
  barcode:string;
  client:string;
  productName:string;
  declaredChineseName:string;
  sourceRow:number;
};

function textValue(value:unknown) {
  return value===null||value===undefined?"":String(value).trim();
}

export function normalizeSkuCatalogRow(row:SkuCatalogSourceRow,sourceRow:number):NormalizedSkuCatalogRow|null {
  const code=textValue(row["SKU"]).toUpperCase();
  if(!code)return null;
  return {
    code,
    barcode:textValue(row["Product Barcode(EAN/UPC)/产品条码 (EAN/UPC)"]),
    client:textValue(row["Client/客户"]),
    productName:textValue(row["Product Name/产品名称"]),
    declaredChineseName:textValue(row["Declared Chinese Name/申报中文名"]),
    sourceRow,
  };
}

export function validateSkuCatalogHeaders(headers:unknown[]) {
  const actual=headers.map(value=>textValue(value));
  const missing=SKU_CATALOG_HEADERS.filter(header=>!actual.includes(header));
  if(missing.length) throw new Error(`Excel 格式不符合要求，缺少列：${missing.join("、")}`);
}
