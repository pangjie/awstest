import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { sessions, users } from "../../../../db/schema";
import { ensureDefaultAdmin, hashPassword, secureEqual, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "../../../../lib/internal-auth";
import { effectivePagePermissions } from "../../../../lib/page-permissions";

export async function POST(request:NextRequest) {
  const { username, password } = await request.json().catch(()=>({})) as {username?:string;password?:string};
  if (!username || !password) return NextResponse.json({error:{message:"请输入账号和密码"}},{status:400});
  await ensureDefaultAdmin();
  const found=await getDb().select().from(users).where(eq(users.username,username.trim().toLowerCase())).limit(1);
  const user=found[0];
  const supplied=await hashPassword(password,user?.passwordSalt??"invalid-login");
  if(!user||!user.active||!secureEqual(supplied,user.passwordHash)) {
    return NextResponse.json({error:{message:"账号或密码不正确"}},{status:401});
  }
  const token=crypto.randomUUID()+crypto.randomUUID().replaceAll("-","");
  const expires=new Date(Date.now()+SESSION_MAX_AGE_SECONDS*1000);
  await getDb().insert(sessions).values({id:token,userId:user.id,expiresAt:expires.toISOString(),createdAt:new Date().toISOString()});
  const response=NextResponse.json({data:{
    name:user.name,role:user.role,pagePermissions:effectivePagePermissions(user.role,user.pagePermissions),
  }});
  response.cookies.set(SESSION_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production"||request.nextUrl.protocol==="https:",sameSite:"strict",path:"/",expires,maxAge:SESSION_MAX_AGE_SECONDS});
  return response;
}
