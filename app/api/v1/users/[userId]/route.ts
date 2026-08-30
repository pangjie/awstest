import { and, eq, ne, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { movements, sessions, users } from "../../../../../db/schema";
import { hashPassword, requireAdmin } from "../../../../../lib/internal-auth";
import { ALL_PAGE_KEYS, effectivePagePermissions, normalizePagePermissions } from "../../../../../lib/page-permissions";
import { lockWarehouseInventory } from "../../../../../lib/warehouse-data";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{userId:string}>}) {
  const admin=await requireAdmin();
  if(!admin) return NextResponse.json({error:{message:"仅管理员可操作"}},{status:403});
  const {userId}=await params;
  const id=Number(userId);
  const body=await request.json().catch(()=>({})) as {active?:unknown;role?:unknown;name?:unknown;pagePermissions?:unknown};
  if(!Number.isInteger(id)||id<1)return NextResponse.json({error:{message:"账号不存在"}},{status:404});
  if(body.role!==undefined&&!(["admin","manager","operator"] as const).includes(body.role as "admin"|"manager"|"operator"))return NextResponse.json({error:{message:"账号角色无效"}},{status:400});
  if(body.active!==undefined&&typeof body.active!=="boolean")return NextResponse.json({error:{message:"账号状态格式无效"}},{status:400});
  if(body.name!==undefined&&(typeof body.name!=="string"||!body.name.trim()))return NextResponse.json({error:{message:"姓名不能为空"}},{status:400});
  if(body.pagePermissions!==undefined&&!Array.isArray(body.pagePermissions))return NextResponse.json({error:{message:"权限范围格式无效"}},{status:400});
  if(id===admin.id&&(body.active===false||(body.role!==undefined&&body.role!=="admin")))return NextResponse.json({error:{message:"不能停用当前账号或取消自己的管理员角色"}},{status:400});
  const result=await getDb().transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7320250826)`);
    await tx.execute(sql`SELECT id FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`);
    const current=(await tx.select().from(users).where(eq(users.id,id)).limit(1))[0];
    if(!current||current.deletedAt)return {error:"账号不存在",status:404 as const};
    const nextRole=(body.role??current.role) as "admin"|"manager"|"operator";
    const nextPermissions=nextRole==="admin"?[...ALL_PAGE_KEYS]:body.pagePermissions===undefined
      ?normalizePagePermissions(current.pagePermissions):normalizePagePermissions(body.pagePermissions);
    if(nextRole!=="admin"&&nextPermissions.length===0)return {error:"请至少授权一个子页面",status:400 as const};
    const removesAdmin=current.active&&current.role==="admin"&&(body.active===false||(body.role!==undefined&&body.role!=="admin"));
    if(removesAdmin) {
      const otherAdmins=await tx.select({id:users.id}).from(users).where(and(eq(users.active,true),eq(users.role,"admin"),ne(users.id,id))).limit(1);
      if(!otherAdmins.length)return {error:"系统必须保留至少一个有效管理员账号",status:409 as const};
    }
    const [updated]=await tx.update(users).set({
      ...(typeof body.active==="boolean"?{active:body.active}:{}),...(body.role!==undefined?{role:body.role as "admin"|"manager"|"operator"}:{}),
      ...(typeof body.name==="string"?{name:body.name.trim()}:{}),pagePermissions:nextPermissions,
    }).where(eq(users.id,id)).returning({
      id:users.id,name:users.name,role:users.role,pagePermissions:users.pagePermissions,active:users.active,
    });
    await recordWarehouseRevision(tx);
    return {data:{...updated,pagePermissions:effectivePagePermissions(updated.role,updated.pagePermissions)}};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}

export async function DELETE(_:NextRequest,{params}:{params:Promise<{userId:string}>}) {
  const admin=await requireAdmin();
  if(!admin) return NextResponse.json({error:{message:"仅管理员可操作"}},{status:403});
  const {userId}=await params;
  const id=Number(userId);
  if(!Number.isInteger(id)||id<1)return NextResponse.json({error:{message:"账号不存在"}},{status:404});
  if(id===admin.id) return NextResponse.json({error:{message:"不能删除当前登录账号"}},{status:400});
  const deletionKey=crypto.randomUUID();
  const passwordSalt=crypto.randomUUID();
  const passwordHash=await hashPassword(crypto.randomUUID()+crypto.randomUUID(),passwordSalt);
  const result=await getDb().transaction(async tx=>{
    await lockWarehouseInventory(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7320250826)`);
    await tx.execute(sql`SELECT id FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`);
    const current=(await tx.select().from(users).where(eq(users.id,id)).limit(1))[0];
    if(!current||current.deletedAt)return {error:"账号不存在",status:404 as const};
    if(current.active&&current.role==="admin") {
      const otherAdmins=await tx.select({id:users.id}).from(users).where(and(eq(users.active,true),eq(users.role,"admin"),ne(users.id,id))).limit(1);
      if(!otherAdmins.length)return {error:"系统必须保留至少一个有效管理员账号",status:409 as const};
    }
    await tx.update(movements).set({
      sourceOperatorUsername:sql`COALESCE(${movements.sourceOperatorUsername},${current.username})`,
      sourceOperatorName:sql`COALESCE(${movements.sourceOperatorName},${current.name})`,
    }).where(eq(movements.operatorId,id));
    await tx.delete(sessions).where(eq(sessions.userId,id));
    await tx.update(users).set({
      username:`deleted-${id}-${deletionKey}`,
      email:`deleted-${id}-${deletionKey}@neiku.local`,
      name:`已删除账号 #${id}`,
      passwordHash,passwordSalt,role:"operator",pagePermissions:[],active:false,
      deletedAt:new Date().toISOString(),
    }).where(eq(users.id,id));
    await recordWarehouseRevision(tx);
    return {ok:true as const};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}
