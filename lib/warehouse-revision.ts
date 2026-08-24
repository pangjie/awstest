import { desc } from "drizzle-orm";
import { getDb } from "../db";
import { warehouseRevisions } from "../db/schema";

export async function recordWarehouseRevision() {
  await getDb().insert(warehouseRevisions).values({changedAt:new Date().toISOString()});
}

export async function getWarehouseRevision() {
  const row=(await getDb().select({revision:warehouseRevisions.id}).from(warehouseRevisions)
    .orderBy(desc(warehouseRevisions.id)).limit(1))[0];
  return Number(row?.revision??0);
}
