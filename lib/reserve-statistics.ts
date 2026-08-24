export type ReserveSkuStatistic = {
  sku: string;
  palletCount: number;
};

type StatisticPallet = {
  sku: string;
  locationId: number | null;
};

type StatisticLocation = {
  id: number;
  type: "reserve" | "pick";
};

export function buildReserveSkuStatistics(
  pallets: StatisticPallet[],
  locations: StatisticLocation[],
): ReserveSkuStatistic[] {
  const reserveLocationIds = new Set(
    locations.filter(location => location.type === "reserve").map(location => location.id),
  );
  const counts = new Map<string, ReserveSkuStatistic>();

  for (const pallet of pallets) {
    if (pallet.locationId === null || !reserveLocationIds.has(pallet.locationId)) continue;
    const sku = pallet.sku.trim();
    if (!sku) continue;
    const key = sku.toUpperCase();
    const current = counts.get(key);
    if (current) current.palletCount += 1;
    else counts.set(key, {sku, palletCount: 1});
  }

  return [...counts.values()].sort(
    (a, b) => b.palletCount - a.palletCount
      || a.sku.localeCompare(b.sku, "zh-CN", {numeric: true, sensitivity: "base"}),
  );
}
