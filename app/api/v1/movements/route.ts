import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { locations, movements, pallets, skus, tasks, users, warehouseRevisions } from "../../../../db/schema";
import { authorizePageAccess } from "../../../../lib/internal-auth";
import { normalizeWarehouseLedgerRow, validateWarehouseLedgerRows, type NormalizedWarehouseLedgerRow } from "../../../../lib/warehouse-ledger-excel";
import { lockWarehouseInventory } from "../../../../lib/warehouse-data";
import { parseStoredTimestamp } from "../../../../lib/warehouse-time";

export async function GET(request:NextRequest) {
  const access=await authorizePageAccess("warehouse-ledger");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const params=request.nextUrl.searchParams;
  const q=params.get("q")?.trim();
  const sku=params.get("sku")?.trim();
  const pallet=params.get("pallet")?.trim();
  const location=params.get("location")?.trim();
  const action=params.get("action");
  const operator=params.get("operator")?.trim();
  const from=params.get("from");
  const to=params.get("to");
  const limit=Math.min(1000,Math.max(1,Number(params.get("limit"))||100));
  const offset=Math.max(0,Number(params.get("offset"))||0);
  const conditions=[
    sku?ilike(skus.code,`%${sku}%`):undefined,
    pallet?ilike(movements.palletId,`%${pallet}%`):undefined,
    action?eq(movements.action,action as typeof movements.action.enumValues[number]):undefined,
    from?gte(movements.occurredAt,from):undefined,
    to?lte(movements.occurredAt,to):undefined,
    location?sql`(fl.code ILIKE ${`%${location}%`} OR tl.code ILIKE ${`%${location}%`})`:undefined,
    operator?or(
      ilike(movements.sourceOperatorUsername,`%${operator}%`),ilike(movements.sourceOperatorName,`%${operator}%`),
      ilike(users.username,`%${operator}%`),ilike(users.name,`%${operator}%`),
    ):undefined,
    q?or(
      ilike(skus.code,`%${q}%`),ilike(movements.remarks,`%${q}%`),ilike(pallets.remarks,`%${q}%`),ilike(movements.palletId,`%${q}%`),
      ilike(movements.sourceTaskId,`%${q}%`),ilike(tasks.id,`%${q}%`),
      ilike(movements.sourceOperatorName,`%${q}%`),ilike(users.name,`%${q}%`),ilike(users.username,`%${q}%`),
      sql`fl.code ILIKE ${`%${q}%`}`,sql`tl.code ILIKE ${`%${q}%`}`,
    ):undefined,
  ].filter((value):value is NonNullable<typeof value>=>Boolean(value));
  const rows=await getDb().select({
    id:movements.id,sourceId:sql<number>`COALESCE(${movements.sourceRecordId},${movements.id})`,palletId:movements.palletId,sku:skus.code,
    remarks:sql<string>`COALESCE(${movements.remarks},${pallets.remarks},'')`,
    taskId:sql<string|null>`COALESCE(${movements.sourceTaskId},${tasks.id})`,
    action:movements.action,quantity:movements.quantity,occurredAt:movements.occurredAt,
    fromLocation:sql<string|null>`fl.code`,fromLocationType:sql<"reserve"|"pick"|null>`fl.type`,
    toLocation:sql<string|null>`tl.code`,toLocationType:sql<"reserve"|"pick"|null>`tl.type`,
    operator:sql<string|null>`COALESCE(${movements.sourceOperatorName},${users.name})`,
    operatorUsername:sql<string|null>`COALESCE(${movements.sourceOperatorUsername},${users.username})`,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id)).leftJoin(pallets,eq(movements.palletId,pallets.id)).leftJoin(tasks,eq(movements.taskId,tasks.id))
    .leftJoin(users,eq(movements.operatorId,users.id))
    .leftJoin(sql`${locations} AS fl`,sql`fl.id = ${movements.fromLocationId}`)
    .leftJoin(sql`${locations} AS tl`,sql`tl.id = ${movements.toLocationId}`)
    .where(conditions.length?and(...conditions):undefined).orderBy(desc(movements.occurredAt),desc(movements.id)).limit(limit).offset(offset);
  return NextResponse.json({data:rows,meta:{count:rows.length,limit,offset,nextOffset:rows.length===limit?offset+limit:null}});
}

export async function POST(request:NextRequest) {
  const access=await authorizePageAccess("warehouse-ledger");
  if(!access.authorized)return NextResponse.json({error:{message:access.message}},{status:access.status});
  const body=await request.json().catch(()=>({})) as {action?:"import";rows?:Array<Record<string,unknown>>};
  if(body.action!=="import")return NextResponse.json({error:{message:"不支持的操作"}},{status:400});
  try {
    if(!Array.isArray(body.rows))throw new Error("没有收到可导入的操作历史");
    const normalized=body.rows.flatMap((row,index)=>{
      const item=normalizeWarehouseLedgerRow({
        "记录ID":row.sourceId,"发生时间（美东）":row.occurredAt,"动作":row.action,
        "SKU":row.sku,"托盘号":row.palletId,"起始库位":row.fromLocation,
        "起始库位类型":row.fromLocationType,"目标库位":row.toLocation,"目标库位类型":row.toLocationType,
        "备注说明":row.remarks,"任务号":row.taskId,"操作账号":row.operatorUsername,"操作人":row.operatorName,
      },Number(row.sourceRow)||index+2);
      return item?[item]:[];
    });
    validateWarehouseLedgerRows(normalized);

    const result=await getDb().transaction(async tx=>{
      await lockWarehouseInventory(tx);

      const palletIds=Array.from(new Set(normalized.map(row=>row.palletId)));
      const palletRows=await tx.select({id:pallets.id,skuId:pallets.skuId,sku:skus.code})
        .from(pallets).innerJoin(skus,eq(pallets.skuId,skus.id)).where(inArray(pallets.id,palletIds));
      const palletById=new Map(palletRows.map(row=>[row.id,row]));
      const latestByPalletId=latestRowsByPallet(normalized);
      const importSkuCodes=Array.from(new Set(normalized.map(row=>row.sku)));
      for(const group of chunks(importSkuCodes,500)) {
        await tx.insert(skus).values(group.map(code=>({code,unit:"箱"}))).onConflictDoNothing({target:skus.code});
      }
      const skuRows=await tx.select({id:skus.id,code:skus.code}).from(skus).where(inArray(skus.code,importSkuCodes));
      const skuIdByCode=new Map(skuRows.map(row=>[row.code,row.id]));
      const invalidPallet=palletRows.map(pallet=>latestByPalletId.get(pallet.id)!).find(row=>palletById.get(row.palletId)!.sku.toUpperCase()!==row.sku);
      if(invalidPallet) {
        throw new Error(`第 ${invalidPallet.sourceRow} 行的托盘 ${invalidPallet.palletId} 无法导入：托盘实际 SKU 为 ${palletById.get(invalidPallet.palletId)!.sku}`);
      }

      const missingPalletIds=palletIds.filter(id=>!palletById.has(id));
      const unsafeMissing=missingPalletIds.map(id=>latestByPalletId.get(id)!).find(row=>row.action!=="pick");
      if(unsafeMissing) {
        throw new Error(`第 ${unsafeMissing.sourceRow} 行的托盘 ${unsafeMissing.palletId} 无法自动补建：它的最新状态不是“全部取出”。请先导入备库总表，以免台账改写当前库存`);
      }
      if(missingPalletIds.length) {
        const rowsByPalletId=groupRowsByPallet(normalized);
        const historicalPallets=missingPalletIds.map(id=>{
          const rows=rowsByPalletId.get(id)!;
          const latest=latestByPalletId.get(id)!;
          const inboundRows=rows.filter(row=>row.action==="inbound");
          const inboundAt=(inboundRows.length?inboundRows:rows).reduce((earliest,row)=>row.occurredAt<earliest?row.occurredAt:earliest,rows[0].occurredAt);
          const remarks=[...rows].sort(compareLedgerRowsNewestFirst).find(row=>row.remarks)?.remarks??"";
          return {id,skuId:skuIdByCode.get(latest.sku)!,locationId:null,remarks,status:"depleted" as const,inboundAt,updatedAt:latest.occurredAt};
        });
        for(const group of chunks(historicalPallets,500))await tx.insert(pallets).values(group);
        for(const pallet of historicalPallets) {
          palletById.set(pallet.id,{id:pallet.id,skuId:pallet.skuId,sku:latestByPalletId.get(pallet.id)!.sku});
        }
      }

      const locationCodes=Array.from(new Set(normalized.flatMap(row=>[row.fromLocation,row.toLocation]).filter(Boolean)));
      const locationRows=locationCodes.length?await tx.select().from(locations).where(inArray(locations.code,locationCodes)):[];
      const locationByKey=new Map(locationRows.map(location=>[locationKey(location.code,location.type),location]));
      for(const row of normalized) {
        for(const ref of [
          {label:"起始",code:row.fromLocation,type:row.fromLocationType},
          {label:"目标",code:row.toLocation,type:row.toLocationType},
        ]) {
          if(ref.code&&ref.type&&!locationByKey.has(locationKey(ref.code,ref.type))) {
            throw new Error(`第 ${row.sourceRow} 行的${ref.label}库位不存在：${ref.code}（${ref.type==="reserve"?"备货库位":"拣货库位"}）`);
          }
        }
      }

      const taskIds=Array.from(new Set(normalized.map(row=>row.taskId).filter(Boolean)));
      const taskRows=taskIds.length?await tx.select({id:tasks.id}).from(tasks).where(inArray(tasks.id,taskIds)):[];
      const validTasks=new Set(taskRows.map(row=>row.id));

      const userRows=await tx.select({id:users.id,username:users.username,name:users.name}).from(users);
      const userByUsername=new Map(userRows.map(row=>[row.username.toLowerCase(),row]));
      const userByName=new Map(userRows.map(row=>[row.name,row]));
      const operatorByRow=new Map<NormalizedWarehouseLedgerRow,(typeof userRows)[number]|null>();
      for(const row of normalized) {
        const operator=row.operatorUsername?userByUsername.get(row.operatorUsername):row.operatorName?userByName.get(row.operatorName):null;
        operatorByRow.set(row,operator??null);
      }

      const existingFingerprints=new Set<string>();
      const existingRows=await selectExistingMovements(tx,inArray(movements.palletId,palletIds));
      const existingSourceFingerprints=new Set(existingRows.map(sourceFingerprint));
      for(const row of existingRows)existingFingerprints.add(contentFingerprint(row));
      const created:NormalizedWarehouseLedgerRow[]=[];
      for(const row of normalized) {
        const comparable=inputComparable(row,locationByKey,operatorByRow.get(row));
        const duplicate=row.sourceId===null
          ?existingFingerprints.has(contentFingerprint(comparable))
          :existingSourceFingerprints.has(sourceFingerprint(comparable));
        if(duplicate)continue;
        existingFingerprints.add(contentFingerprint(comparable));
        existingSourceFingerprints.add(sourceFingerprint(comparable));
        created.push(row);
      }
      const values=(row:NormalizedWarehouseLedgerRow)=>({
        ...operatorSnapshot(row,operatorByRow.get(row)),
        sourceRecordId:row.sourceId,palletId:row.palletId,skuId:skuIdByCode.get(row.sku)!,
        taskId:row.taskId&&validTasks.has(row.taskId)?row.taskId:null,sourceTaskId:row.taskId||null,action:row.action,
        fromLocationId:row.fromLocation&&row.fromLocationType?locationByKey.get(locationKey(row.fromLocation,row.fromLocationType))!.id:null,
        toLocationId:row.toLocation&&row.toLocationType?locationByKey.get(locationKey(row.toLocation,row.toLocationType))!.id:null,
        quantity:0,remarks:row.remarks,occurredAt:row.occurredAt,
      });
      for(const group of chunks(created,500))await tx.insert(movements).values(group.map(values));
      if(created.length)await tx.insert(warehouseRevisions).values({changedAt:new Date().toISOString()});
      return {importedRows:normalized.length,createdRows:created.length,skippedRows:normalized.length-created.length};
    });
    return NextResponse.json({data:result});
  } catch(error) {
    return NextResponse.json({error:{message:error instanceof Error?error.message:"仓库台账导入失败"}},{status:400});
  }
}

type ExistingMovement={
  sourceId:number;palletId:string;sku:string;taskId:string|null;action:string;occurredAt:string;remarks:string;
  operatorUsername:string;operatorName:string;fromLocationId:number|null;toLocationId:number|null;
};

type DatabaseTransaction=Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function selectExistingMovements(tx:DatabaseTransaction,condition:SQL) {
  return tx.select({
    sourceId:sql<number>`COALESCE(${movements.sourceRecordId},${movements.id})`,
    palletId:movements.palletId,sku:skus.code,taskId:sql<string|null>`COALESCE(${movements.sourceTaskId},${movements.taskId})`,
    action:movements.action,occurredAt:movements.occurredAt,remarks:sql<string>`COALESCE(${movements.remarks},${pallets.remarks},'')`,
    operatorUsername:sql<string>`COALESCE(${movements.sourceOperatorUsername},${users.username},'')`,
    operatorName:sql<string>`COALESCE(${movements.sourceOperatorName},${users.name},'')`,
    fromLocationId:movements.fromLocationId,toLocationId:movements.toLocationId,
  }).from(movements).innerJoin(skus,eq(movements.skuId,skus.id))
    .leftJoin(pallets,eq(movements.palletId,pallets.id)).leftJoin(users,eq(movements.operatorId,users.id)).where(condition);
}

function contentFingerprint(row:ExistingMovement) {
  return [row.palletId,row.sku,row.action,storedIso(row.occurredAt),row.taskId??"",row.fromLocationId??0,row.toLocationId??0,
    row.remarks,row.operatorUsername,row.operatorName].join("\u001f");
}

function sourceFingerprint(row:ExistingMovement) {
  return `${row.sourceId}\u001f${contentFingerprint(row)}`;
}

type LedgerOperator={id:number;username:string;name:string}|null|undefined;

function operatorSnapshot(row:NormalizedWarehouseLedgerRow,operator:LedgerOperator) {
  return {
    operatorId:operator?.id??null,
    sourceOperatorUsername:row.operatorUsername||operator?.username||null,
    sourceOperatorName:row.operatorName||operator?.name||null,
  };
}

function inputComparable(row:NormalizedWarehouseLedgerRow,locationByKey:ReadonlyMap<string,{id:number}>,operator:LedgerOperator):ExistingMovement {
  return {
    sourceId:row.sourceId??0,palletId:row.palletId,sku:row.sku,action:row.action,occurredAt:row.occurredAt,
    taskId:row.taskId||null,fromLocationId:row.fromLocation&&row.fromLocationType?locationByKey.get(locationKey(row.fromLocation,row.fromLocationType))!.id:null,
    toLocationId:row.toLocation&&row.toLocationType?locationByKey.get(locationKey(row.toLocation,row.toLocationType))!.id:null,
    remarks:row.remarks,operatorUsername:row.operatorUsername||operator?.username||"",operatorName:row.operatorName||operator?.name||"",
  };
}

function locationKey(code:string,type:"reserve"|"pick") {return `${type}:${code}`}
function storedIso(value:string) {const parsed=parseStoredTimestamp(value);return Number.isNaN(parsed.getTime())?value:parsed.toISOString()}
function chunks<T>(values:T[],size:number) {return Array.from({length:Math.ceil(values.length/size)},(_,index)=>values.slice(index*size,(index+1)*size))}
function groupRowsByPallet(rows:NormalizedWarehouseLedgerRow[]) {
  const grouped=new Map<string,NormalizedWarehouseLedgerRow[]>();
  for(const row of rows)grouped.set(row.palletId,[...(grouped.get(row.palletId)??[]),row]);
  return grouped;
}
function latestRowsByPallet(rows:NormalizedWarehouseLedgerRow[]) {
  return new Map(Array.from(groupRowsByPallet(rows),([palletId,palletRows])=>[palletId,[...palletRows].sort(compareLedgerRowsNewestFirst)[0]]));
}
function compareLedgerRowsNewestFirst(a:NormalizedWarehouseLedgerRow,b:NormalizedWarehouseLedgerRow) {
  return b.occurredAt.localeCompare(a.occurredAt)||(b.sourceId??-b.sourceRow)-(a.sourceId??-a.sourceRow);
}
