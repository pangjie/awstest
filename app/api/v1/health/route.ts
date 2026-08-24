import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "neiku-api",
    time: new Date().toISOString(),
  });
}
