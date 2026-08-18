import { NextResponse } from "next/server";
import { adminApiFetch } from "@/lib/api";

export async function GET() {
  try {
    const data = await adminApiFetch("/admin/webhooks");
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
