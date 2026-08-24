import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { locations, pallets } from "../db/schema";
import { warehouseDateKey } from "./warehouse-time";

export function createPalletId(sequence=1,date=new Date()) {
  const dateStamp=warehouseDateKey(date).slice(2).replaceAll("-","");
  const normalized=((Math.trunc(sequence)-1)%9999+9999)%9999+1;
  return `P${dateStamp}-${String(normalized).padStart(4,"0")}`;
}

export async function getLocationByCode(code:string,type:"reserve"|"pick") {
  const rows=await getDb().select().from(locations).where(and(eq(locations.code,code),eq(locations.type,type))).limit(1);
  return rows[0]??null;
}

export async function refreshLocationStatus(locationId:number|null) {
  if(!locationId) return;
  const db=getDb();
  if(!(await db.select({id:locations.id}).from(locations).where(eq(locations.id,locationId)).limit(1))[0]) return;
  const active=await db.select({count:sql<number>`count(*)`}).from(pallets)
    .where(and(eq(pallets.locationId,locationId),ne(pallets.status,"depleted")));
  const activeCount=Number(active[0]?.count??0);
  const status=activeCount>0?"occupied":"available";
  await db.update(locations).set({status}).where(eq(locations.id,locationId));
}

export async function getLocationSlotUsage(locationId:number) {
  const db=getDb();
  const location=(await db.select().from(locations).where(eq(locations.id,locationId)).limit(1))[0];
  if(!location) return null;
  const active=await db.select({count:sql<number>`count(*)`}).from(pallets)
    .where(and(eq(pallets.locationId,locationId),ne(pallets.status,"depleted")));
  const palletCount=Number(active[0]?.count??0);
  return {...location,palletCount,availableSlots:Math.max(0,location.capacity-palletCount)};
}
