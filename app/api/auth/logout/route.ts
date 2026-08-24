import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../db";
import { sessions } from "../../../../db/schema";
import { SESSION_COOKIE } from "../../../../lib/internal-auth";

export async function POST(request:NextRequest) {
  const token=request.cookies.get(SESSION_COOKIE)?.value;
  if(token) await getDb().delete(sessions).where(eq(sessions.id,token));
  const response=NextResponse.json({ok:true});
  response.cookies.set(SESSION_COOKIE,"",{httpOnly:true,secure:process.env.NODE_ENV==="production"||request.nextUrl.protocol==="https:",sameSite:"strict",path:"/",maxAge:0});
  return response;
}
