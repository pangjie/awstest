export const WAREHOUSE_DATA_TABS = [
  {key:"tasks",label:"待办任务",icon:"✓",section:"warehouse-data"},
  {key:"sku-management",label:"SKU管理",icon:"#",section:"warehouse-data"},
  {key:"location-management",label:"库位管理",icon:"▤",section:"warehouse-data"},
  {key:"warehouse-ledger",label:"仓库台账",icon:"↺",section:"warehouse-data"},
] as const;

export const TIMEKEEPING_PAGES = [
  {key:"time-scan",label:"任务分发",icon:"⌁",section:"timekeeping"},
  {key:"time-card-scan",label:"工卡扫描",icon:"▣",section:"timekeeping"},
  {key:"time-dashboard",label:"现场看板",icon:"▦",section:"timekeeping"},
  {key:"time-records",label:"工作记录",icon:"◉",section:"timekeeping"},
  {key:"time-employees",label:"员工数据",icon:"♙",section:"timekeeping"},
] as const;

export const PAGE_DEFINITIONS = [
  {key:"dashboard",label:"备货操作",icon:"⌂",section:"main"},
  {key:"reserve-inventory",label:"备库总表",icon:"▦",section:"main"},
  {key:"mobile-tasks",label:"备货待办",icon:"☑",section:"main"},
  ...WAREHOUSE_DATA_TABS,
  ...TIMEKEEPING_PAGES,
] as const;

export type PageKey=(typeof PAGE_DEFINITIONS)[number]["key"];
export type WarehouseDataTabKey=(typeof WAREHOUSE_DATA_TABS)[number]["key"];
export type TimekeepingPageKey=(typeof TIMEKEEPING_PAGES)[number]["key"];

export const NAVIGATION_DEFINITIONS = [
  {key:"dashboard",label:"备货操作",icon:"⌂",group:"warehouse",narrowHidden:false,pagePermissions:["dashboard"]},
  {key:"reserve-inventory",label:"备库总表",icon:"▦",group:"warehouse",narrowHidden:false,pagePermissions:["reserve-inventory"]},
  {key:"mobile-tasks",label:"备货待办",icon:"☑",group:"warehouse",narrowHidden:false,pagePermissions:["mobile-tasks"]},
  {key:"warehouse-data",label:"备货数据",icon:"◇",group:"warehouse",narrowHidden:false,pagePermissions:WAREHOUSE_DATA_TABS.map(tab=>tab.key)},
  ...TIMEKEEPING_PAGES.map(page=>({...page,group:"timekeeping" as const,narrowHidden:false,pagePermissions:[page.key]})),
] as const;

export type PageLabel=(typeof NAVIGATION_DEFINITIONS)[number]["label"];

export function isTimekeepingPageKey(value:string):value is TimekeepingPageKey {
  return TIMEKEEPING_PAGES.some(page=>page.key===value);
}

export const ALL_PAGE_KEYS:PageKey[]=PAGE_DEFINITIONS.map(page=>page.key);
const pageKeySet=new Set<string>(ALL_PAGE_KEYS);

export function normalizePagePermissions(value:unknown):PageKey[] {
  if(!Array.isArray(value))return [];
  const selected=new Set(value.filter((item):item is PageKey=>typeof item==="string"&&pageKeySet.has(item)));
  return ALL_PAGE_KEYS.filter(key=>selected.has(key));
}

export function effectivePagePermissions(role:string,value:unknown):PageKey[] {
  return role==="admin"?[...ALL_PAGE_KEYS]:normalizePagePermissions(value);
}

export function canAccessAnyPage(
  user:{role:string;pagePermissions:readonly PageKey[]},
  pages:readonly PageKey[],
) {
  return user.role==="admin"||pages.some(page=>user.pagePermissions.includes(page));
}
