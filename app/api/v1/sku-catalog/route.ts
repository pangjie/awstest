import { and, asc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb, getPool } from "../../../../db";
import { skuCatalog } from "../../../../db/schema";
import { getInternalUser } from "../../../../lib/internal-auth";
import { SKU_CATALOG_HEADERS } from "../../../../lib/sku-catalog";
import { recordWarehouseRevision } from "../../../../lib/warehouse-revision";

export const dynamic="force-dynamic";

export async function GET(request:NextRequest) {
  if(!await getInternalUser())return NextResponse.json({error:{message:"请先登录"}},{status:401});
  const q=request.nextUrl.searchParams.get("q")?.trim()??"";
  const page=Math.max(1,Number(request.nextUrl.searchParams.get("page")||1));
  const pageSize=Math.min(100,Math.max(20,Number(request.nextUrl.searchParams.get("pageSize")||100)));
  const search=q?or(
    ilike(skuCatalog.code,`%${q}%`),ilike(skuCatalog.barcode,`%${q}%`),
    ilike(skuCatalog.client,`%${q}%`),ilike(skuCatalog.productName,`%${q}%`),
    ilike(skuCatalog.declaredChineseName,`%${q}%`),
  ):undefined;
  const where=and(eq(skuCatalog.active,true),search);
  const db=getDb();
  const rowSelection={
    id:skuCatalog.id,sku:skuCatalog.code,barcode:skuCatalog.barcode,client:skuCatalog.client,
    productName:skuCatalog.productName,declaredChineseName:skuCatalog.declaredChineseName,
    sourceRow:skuCatalog.sourceRow,importedAt:skuCatalog.importedAt,
  };
  const rowQuery=q
    ?db.select(rowSelection).from(skuCatalog).where(where).orderBy(
      sql`CASE WHEN UPPER(${skuCatalog.code})=${q.toUpperCase()} THEN 0 ELSE 1 END`,
      asc(skuCatalog.code),asc(skuCatalog.sourceRow),
    )
    :db.select(rowSelection).from(skuCatalog).where(where).orderBy(asc(skuCatalog.code),asc(skuCatalog.sourceRow));
  const [rows,totalRows,summaryRows]=await Promise.all([
    rowQuery.limit(pageSize).offset((page-1)*pageSize),
    db.select({count:sql<number>`count(*)`}).from(skuCatalog).where(where),
    db.select({
      total:sql<number>`count(*)`,uniqueCodes:sql<number>`count(DISTINCT UPPER(${skuCatalog.code}))`,
      lastImportedAt:sql<string|null>`max(${skuCatalog.importedAt})`,
    }).from(skuCatalog).where(eq(skuCatalog.active,true)),
  ]);
  return NextResponse.json({data:rows,meta:{
    page,pageSize,total:Number(totalRows[0]?.count??0),
    uniqueCodes:Number(summaryRows[0]?.uniqueCodes??0),activeRows:Number(summaryRows[0]?.total??0),
    lastImportedAt:summaryRows[0]?.lastImportedAt??null,
  }});
}

export async function POST(request:NextRequest) {
  if(!await getInternalUser())return NextResponse.json({error:{message:"请先登录"}},{status:401});
  try {
    const body=await request.json() as {
      action?:"start"|"batch"|"finish"|"create";importKey?:string;importedAt?:string;
      code?:unknown;barcode?:unknown;client?:unknown;productName?:unknown;declaredChineseName?:unknown;
      rows?:Array<{code?:unknown;barcode?:unknown;client?:unknown;productName?:unknown;declaredChineseName?:unknown;sourceRow?:unknown}>;
    };
    const db=getDb();
    const text=(value:unknown)=>value===null||value===undefined?"":String(value).trim();

    if(body.action==="create") {
      const code=text(body.code).toUpperCase();
      if(!code)return NextResponse.json({error:{message:"请填写 SKU"}},{status:400});
      const importedAt=new Date().toISOString(),importKey=`manual:${crypto.randomUUID()}`;
      try {
        const result=await db.transaction(async tx=>{
          if((await tx.select({id:skuCatalog.id}).from(skuCatalog)
            .where(and(eq(skuCatalog.active,true),sql`UPPER(${skuCatalog.code})=${code}`)).limit(1)).length) {
            return {duplicate:true as const};
          }
          const [created]=await tx.insert(skuCatalog).values({
            code,barcode:text(body.barcode),client:text(body.client),productName:text(body.productName),
            declaredChineseName:text(body.declaredChineseName),sourceRow:0,importKey,active:true,importedAt,
          }).returning({
            id:skuCatalog.id,sku:skuCatalog.code,barcode:skuCatalog.barcode,client:skuCatalog.client,
            productName:skuCatalog.productName,declaredChineseName:skuCatalog.declaredChineseName,
            sourceRow:skuCatalog.sourceRow,importedAt:skuCatalog.importedAt,
          });
          await recordWarehouseRevision(tx);
          return {data:created};
        });
        if("duplicate" in result)return NextResponse.json({error:{message:`SKU ${code} 已存在，请勿重复添加`}},{status:409});
        return NextResponse.json(result,{status:201});
      } catch(error) {
        if((error as {code?:string}).code==="23505")return NextResponse.json({error:{message:`SKU ${code} 已存在，请勿重复添加`}},{status:409});
        throw error;
      }
    }

    if(body.action==="start") {
      const importKey=crypto.randomUUID(),importedAt=new Date().toISOString();
      await db.delete(skuCatalog).where(and(eq(skuCatalog.active,false),lt(skuCatalog.importedAt,new Date(Date.now()-86_400_000).toISOString())));
      return NextResponse.json({data:{importKey,importedAt,acceptedHeaders:SKU_CATALOG_HEADERS}});
    }
    if(!body.importKey||!body.importedAt)throw new Error("导入会话无效，请重新选择文件");

    if(body.action==="batch") {
      if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>1000)throw new Error("每批 SKU 数据必须为 1 至 1000 条");
      const normalized=body.rows.map((row,index)=>{
        const code=text(row.code).toUpperCase();
        if(!code)throw new Error(`当前批次第 ${index+1} 条缺少 SKU`);
        return {
          code,barcode:text(row.barcode),client:text(row.client),productName:text(row.productName),
          declaredChineseName:text(row.declaredChineseName),sourceRow:Number(row.sourceRow)||0,
          importKey:body.importKey!,active:false,importedAt:body.importedAt!,
        };
      });
      await db.insert(skuCatalog).values(normalized);
      return NextResponse.json({data:{acceptedRows:normalized.length}});
    }

    if(body.action==="finish") {
      const client=await getPool().connect();
      try {
        await client.query("BEGIN");
        const summaryResult=await client.query<{importedrows:string;uniquecodes:string}>(`
          SELECT COUNT(*) AS importedRows,COUNT(DISTINCT UPPER(code)) AS uniqueCodes
          FROM sku_catalog WHERE import_key=$1
        `,[body.importKey]);
        const summary=summaryResult.rows[0];
        const importedRows=Number(summary?.importedrows??0),uniqueCodes=Number(summary?.uniquecodes??0);
        if(!importedRows)throw new Error("没有收到可导入的 SKU 数据");
        const candidates=await client.query<{id:number}>(`
          WITH winner_ids AS (
            SELECT MAX(id) AS id FROM sku_catalog WHERE import_key=$1 GROUP BY UPPER(code)
          )
          SELECT staged.id FROM sku_catalog staged JOIN winner_ids ON winner_ids.id=staged.id
          WHERE NOT EXISTS (
            SELECT 1 FROM sku_catalog existing
            WHERE existing.active=TRUE AND UPPER(existing.code)=UPPER(staged.code)
          )
        `,[body.importKey]);
        const candidateIds=candidates.rows.map(row=>Number(row.id));
        await client.query(`
          WITH winner_ids AS (
            SELECT MAX(id) AS id FROM sku_catalog WHERE import_key=$1 GROUP BY UPPER(code)
          ),winners AS (
            SELECT staged.* FROM sku_catalog staged JOIN winner_ids ON winner_ids.id=staged.id
          )
          UPDATE sku_catalog AS existing SET
            code=winner.code,barcode=winner.barcode,client=winner.client,
            product_name=winner.product_name,declared_chinese_name=winner.declared_chinese_name,
            source_row=winner.source_row,import_key=winner.import_key,imported_at=winner.imported_at
          FROM winners winner
          WHERE existing.active=TRUE AND UPPER(existing.code)=UPPER(winner.code)
        `,[body.importKey]);
        if(candidateIds.length)await client.query("UPDATE sku_catalog SET active=TRUE WHERE id=ANY($1::int[])",[candidateIds]);
        await client.query("DELETE FROM sku_catalog WHERE import_key=$1 AND active=FALSE",[body.importKey]);
        await client.query("INSERT INTO warehouse_revisions (changed_at) VALUES (CURRENT_TIMESTAMP)");
        await client.query("COMMIT");
        return NextResponse.json({data:{
          importedRows,uniqueCodes,addedCodes:candidateIds.length,updatedCodes:uniqueCodes-candidateIds.length,
          duplicateCodes:importedRows-uniqueCodes,importedAt:body.importedAt,
        }});
      } catch(error) {
        await client.query("ROLLBACK").catch(()=>undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error("不支持的 SKU 导入操作");
  } catch(error) {
    return NextResponse.json({error:{message:error instanceof Error?error.message:"SKU 数据导入失败"}},{status:400});
  }
}
