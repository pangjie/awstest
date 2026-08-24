import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { locations, movements, pallets, skus, warehouseRevisions } from "../../../../../db/schema";
import { getInternalUser } from "../../../../../lib/internal-auth";
import { normalizeReserveInventoryRow, validateReserveInventoryRows, type NormalizedReserveInventoryRow } from "../../../../../lib/reserve-inventory-excel";
import { createPalletId, lockWarehouseInventory } from "../../../../../lib/warehouse-data";
import { parseStoredTimestamp } from "../../../../../lib/warehouse-time";

type ExistingPallet={
  id:string;
  sku:string;
  location:string|null;
  locationId:number|null;
  remarks:string;
  status:"in_stock"|"in_task"|"depleted";
  inboundAt:string;
};

export async function POST(request:NextRequest) {
  const user=await getInternalUser();
  if(!user)return NextResponse.json({error:{message:"请先登录"}},{status:401});
  try {
    const body=await request.json().catch(()=>({})) as {rows?:Array<Record<string,unknown>>};
    if(!Array.isArray(body.rows))throw new Error("没有收到可导入的备库总表数据");
    const normalized=body.rows.flatMap((row,index)=>{
      const slotIndex=Number(row.slotIndex),slotCapacity=Number(row.slotCapacity);
      const item=normalizeReserveInventoryRow({
        "库位":row.location,
        "托盘位":Number.isInteger(slotIndex)&&Number.isInteger(slotCapacity)?`${slotIndex}/${slotCapacity}`:"",
        "SKU":row.sku,
        "托盘号":row.palletId,
        "备注说明":row.remarks,
        "入库时间（美东）":row.inboundAt,
        "库龄（天）":"",
        "状态":row.status,
      },Number(row.sourceRow)||index+2);
      return item?[item]:[];
    });
    validateReserveInventoryRows(normalized);

    const result=await getDb().transaction(async tx=>{
      await lockWarehouseInventory(tx);

      const allPalletIds=await tx.select({id:pallets.id}).from(pallets);
      assignMissingPalletIds(normalized,new Set(allPalletIds.map(row=>row.id)));
      validateReserveInventoryRows(normalized);

      const requestedLocations=Array.from(new Set(normalized.map(row=>row.location)));
      const locationRows=await tx.select().from(locations)
        .where(and(eq(locations.type,"reserve"),inArray(locations.code,requestedLocations)));
      const locationByCode=new Map(locationRows.map(location=>[location.code,location]));
      const invalidLocation=normalized.find(row=>!locationByCode.has(row.location));
      if(invalidLocation)throw new Error(`第 ${invalidLocation.sourceRow} 行的备货库位不存在：${invalidLocation.location}`);

      const requestedPalletIds=normalized.map(row=>row.palletId);
      const existingRows=await tx.select({
        id:pallets.id,sku:skus.code,location:locations.code,locationId:pallets.locationId,
        remarks:pallets.remarks,status:pallets.status,inboundAt:pallets.inboundAt,
      }).from(pallets).innerJoin(skus,eq(pallets.skuId,skus.id)).leftJoin(locations,eq(pallets.locationId,locations.id))
        .where(inArray(pallets.id,requestedPalletIds));
      const existingById=new Map(existingRows.map(row=>[row.id,row as ExistingPallet]));
      const created:NormalizedReserveInventoryRow[]=[],updated:NormalizedReserveInventoryRow[]=[],skipped:NormalizedReserveInventoryRow[]=[];

      for(const row of normalized) {
        const existing=existingById.get(row.palletId);
        if(!existing) {
          if(row.status==="in_task")throw new Error(`第 ${row.sourceRow} 行的作业中托盘 ${row.palletId} 不存在，不能通过备库总表新建作业状态`);
          created.push(row);continue;
        }
        if(existing.status==="depleted")throw new Error(`第 ${row.sourceRow} 行的托盘号 ${row.palletId} 已用于历史出库托盘，不能重新启用`);
        if(existing.status!==row.status)throw new Error(`第 ${row.sourceRow} 行的托盘 ${row.palletId} 当前状态与文件不一致；请刷新导出文件后重试`);
        const same=existing.sku.toUpperCase()===row.sku
          &&(existing.location??"").toUpperCase()===row.location
          &&existing.remarks===row.remarks
          &&storedIso(existing.inboundAt)===row.inboundAt;
        if(existing.status==="in_task"&&!same)throw new Error(`第 ${row.sourceRow} 行的托盘 ${row.palletId} 正在作业，不能通过 Excel 修改`);
        if(same)skipped.push(row);else updated.push(row);
      }

      const occupancyRows=await tx.select({locationId:pallets.locationId,count:sql<number>`COUNT(*)::INTEGER`})
        .from(pallets).where(and(sql`${pallets.locationId} IS NOT NULL`,ne(pallets.status,"depleted")))
        .groupBy(pallets.locationId);
      const finalOccupancy=new Map<number,number>(occupancyRows.flatMap(row=>row.locationId===null?[]:[[row.locationId,Number(row.count)]]));
      for(const row of normalized) {
        const existing=existingById.get(row.palletId);
        if(existing?.locationId)finalOccupancy.set(existing.locationId,(finalOccupancy.get(existing.locationId)??0)-1);
        const target=locationByCode.get(row.location)!;
        finalOccupancy.set(target.id,(finalOccupancy.get(target.id)??0)+1);
      }
      const capacityConflict=locationRows.find(location=>(finalOccupancy.get(location.id)??0)>location.capacity);
      if(capacityConflict)throw new Error(`导入后备货库位 ${capacityConflict.code} 将占用 ${finalOccupancy.get(capacityConflict.id)} 托，超过容量 ${capacityConflict.capacity}`);

      const changed=[...created,...updated];
      if(changed.length) {
        const now=new Date().toISOString();
        const skuCodes=Array.from(new Set(changed.map(row=>row.sku)));
        for(const group of chunks(skuCodes,1_000)) {
          await tx.insert(skus).values(group.map(code=>({code,unit:"箱",createdAt:now}))).onConflictDoNothing({target:skus.code});
        }
        const skuRows=await tx.select({id:skus.id,code:skus.code}).from(skus).where(inArray(skus.code,skuCodes));
        const skuByCode=new Map(skuRows.map(row=>[row.code,row.id]));

        for(const group of chunks(changed,500)) {
          await tx.insert(pallets).values(group.map(row=>({
            id:row.palletId,skuId:skuByCode.get(row.sku)!,locationId:locationByCode.get(row.location)!.id,
            remarks:row.remarks,status:"in_stock" as const,inboundAt:row.inboundAt,updatedAt:now,
          }))).onConflictDoUpdate({
            target:pallets.id,
            set:{
              skuId:sql`excluded.sku_id`,locationId:sql`excluded.location_id`,remarks:sql`excluded.remarks`,
              status:"in_stock",inboundAt:sql`excluded.inbound_at`,updatedAt:sql`excluded.updated_at`,
            },
            setWhere:sql`${pallets.status} = 'in_stock'`,
          });
        }

        const movementRows=[
          ...created.map(row=>({row,action:"inbound" as const,fromLocationId:null,occurredAt:row.inboundAt})),
          ...updated.map(row=>({row,action:"adjust" as const,fromLocationId:existingById.get(row.palletId)?.locationId??null,occurredAt:now})),
        ];
        for(const group of chunks(movementRows,500)) {
          await tx.insert(movements).values(group.map(item=>({
            palletId:item.row.palletId,skuId:skuByCode.get(item.row.sku)!,taskId:null,action:item.action,
            fromLocationId:item.fromLocationId,toLocationId:locationByCode.get(item.row.location)!.id,
            quantity:0,remarks:item.row.remarks,occurredAt:item.occurredAt,operatorId:user.id,
          })));
        }
        await tx.update(locations).set({
          status:sql`CASE WHEN EXISTS (
            SELECT 1 FROM ${pallets}
            WHERE ${pallets.locationId} = ${locations.id} AND ${pallets.status} != 'depleted'
          ) THEN 'occupied' ELSE 'available' END`,
        }).where(eq(locations.type,"reserve"));
        await tx.insert(warehouseRevisions).values({changedAt:now});
      }

      return {importedRows:normalized.length,createdRows:created.length,updatedRows:updated.length,skippedRows:skipped.length};
    });

    return NextResponse.json({data:result});
  } catch(error) {
    return NextResponse.json({error:{message:error instanceof Error?error.message:"备库总表导入失败"}},{status:400});
  }
}

function assignMissingPalletIds(rows:NormalizedReserveInventoryRow[],existingIds:Set<string>) {
  const used=new Set([...existingIds,...rows.flatMap(row=>row.palletId?[row.palletId]:[])]),nextByDate=new Map<string,number>();
  for(const row of rows) {
    if(row.palletId)continue;
    const date=new Date(row.inboundAt),dateKey=row.inboundAt.slice(0,10);
    let sequence=nextByDate.get(dateKey)??1,palletId="";
    for(let attempts=0;attempts<9_999;attempts++,sequence++) {
      const candidate=createPalletId(sequence,date);
      if(!used.has(candidate)){palletId=candidate;sequence++;break}
    }
    if(!palletId)throw new Error(`第 ${row.sourceRow} 行无法分配托盘号，请联系管理员`);
    row.palletId=palletId;used.add(palletId);nextByDate.set(dateKey,sequence);
  }
}

function storedIso(value:string) {
  const parsed=parseStoredTimestamp(value);
  return Number.isNaN(parsed.getTime())?value:parsed.toISOString();
}

function chunks<T>(values:T[],size:number) {
  return Array.from({length:Math.ceil(values.length/size)},(_,index)=>values.slice(index*size,(index+1)*size));
}
