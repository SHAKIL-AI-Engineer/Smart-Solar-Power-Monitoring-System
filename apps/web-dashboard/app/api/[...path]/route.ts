import type { NextRequest } from "next/server";
import { handleCloud } from "../../../server/cloud-api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  return handleCloud(request, (await context.params).path);
}
export { handle as GET, handle as POST };
