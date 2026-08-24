import { and, eq, ne, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../db";
import { users } from "../../../../../db/schema";
import { requireAdmin } from "../../../../../lib/internal-auth";
import { recordWarehouseRevision } from "../../../../../lib/warehouse-revision";

export async function PATCH(request:NextRequest,{params}:{params:Promise<{userId:string}>}) {
  const admin=await requireAdmin();
  if(!admin) return NextResponse.json({error:{message:"仅管理员可操作"}},{status:403});
  const {userId}=await params;
  const id=Number(userId);
  const body=await request.json().catch(()=>({})) as {active?:boolean;role?:"admin"|"manager"|"operator";name?:string};
  if(!Number.isInteger(id)||id<1)return NextResponse.json({error:{message:"账号不存在"}},{status:404});
  if(body.role&&!(["admin","manager","operator"] as const).includes(body.role))return NextResponse.json({error:{message:"账号角色无效"}},{status:400});
  if(body.name!==undefined&&!body.name.trim())return NextResponse.json({error:{message:"姓名不能为空"}},{status:400});
  if(id===admin.id&&(body.active===false||(body.role&&body.role!=="admin")))return NextResponse.json({error:{message:"不能停用当前账号或取消自己的管理员角色"}},{status:400});
  const result=await getDb().transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7320250826)`);
    await tx.execute(sql`SELECT id FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`);
    const current=(await tx.select().from(users).where(eq(users.id,id)).limit(1))[0];
    if(!current)return {error:"账号不存在",status:404 as const};
    const removesAdmin=current.active&&current.role==="admin"&&(body.active===false||(body.role!==undefined&&body.role!=="admin"));
    if(removesAdmin) {
      const otherAdmins=await tx.select({id:users.id}).from(users).where(and(eq(users.active,true),eq(users.role,"admin"),ne(users.id,id))).limit(1);
      if(!otherAdmins.length)return {error:"系统必须保留至少一个有效管理员账号",status:409 as const};
    }
    const [updated]=await tx.update(users).set({
      ...(typeof body.active==="boolean"?{active:body.active}:{}),...(body.role?{role:body.role}:{}),...(body.name!==undefined?{name:body.name.trim()}:{}),
    }).where(eq(users.id,id)).returning({id:users.id,name:users.name,role:users.role,active:users.active});
    await recordWarehouseRevision(tx);
    return {data:updated};
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
  const result=await getDb().transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7320250826)`);
    await tx.execute(sql`SELECT id FROM ${users} WHERE ${users.id}=${id} FOR UPDATE`);
    const current=(await tx.select().from(users).where(eq(users.id,id)).limit(1))[0];
    if(!current)return {error:"账号不存在",status:404 as const};
    if(current.active&&current.role==="admin") {
      const otherAdmins=await tx.select({id:users.id}).from(users).where(and(eq(users.active,true),eq(users.role,"admin"),ne(users.id,id))).limit(1);
      if(!otherAdmins.length)return {error:"系统必须保留至少一个有效管理员账号",status:409 as const};
    }
    await tx.update(users).set({active:false}).where(eq(users.id,id));
    await recordWarehouseRevision(tx);
    return {ok:true as const};
  });
  if("error" in result)return NextResponse.json({error:{message:result.error}},{status:result.status});
  return NextResponse.json(result);
}
