import { NextResponse } from "next/server";
import { isDatabaseReady } from "../../../db/runtime";

export const dynamic="force-dynamic";

export async function GET() {
  try {
    await isDatabaseReady();
    return NextResponse.json({status:"ready"},{headers:{"cache-control":"no-store"}});
  } catch {
    return NextResponse.json({status:"not_ready"},{status:503,headers:{"cache-control":"no-store"}});
  }
}
