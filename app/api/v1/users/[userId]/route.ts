import { eq } from "drizzle-orm";
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
  if(id===admin.id&&body.active===false) return NextResponse.json({error:{message:"不能停用当前登录账号"}},{status:400});
  const updated=await getDb().update(users).set({
    ...(typeof body.active==="boolean"?{active:body.active}:{}),...(body.role?{role:body.role}:{}),...(body.name?{name:body.name.trim()}:{}),
  }).where(eq(users.id,id)).returning({id:users.id,name:users.name,role:users.role,active:users.active});
  if(!updated.length) return NextResponse.json({error:{message:"账号不存在"}},{status:404});
  await recordWarehouseRevision();
  return NextResponse.json({data:updated[0]});
}

export async function DELETE(_:NextRequest,{params}:{params:Promise<{userId:string}>}) {
  const admin=await requireAdmin();
  if(!admin) return NextResponse.json({error:{message:"仅管理员可操作"}},{status:403});
  const {userId}=await params;
  const id=Number(userId);
  if(id===admin.id) return NextResponse.json({error:{message:"不能删除当前登录账号"}},{status:400});
  await getDb().update(users).set({active:false}).where(eq(users.id,id));
  await recordWarehouseRevision();
  return NextResponse.json({ok:true});
}
