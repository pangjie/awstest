"use client";

import { formatWarehouseTime } from "./warehouse-time";

export type WarehouseTaskSheetType = "store" | "pick" | "move";

export type WarehouseTaskSheetRow = {
  sku: string;
  fromLocation: string;
  toLocation: string;
  note?: string;
};

type WarehouseTaskSheetInput = {
  taskId: string;
  type: WarehouseTaskSheetType;
  rows: WarehouseTaskSheetRow[];
};

const ROWS_PER_PAGE = 9;
const TYPE_NAMES: Record<WarehouseTaskSheetType, string> = {
  store: "存备货",
  pick: "取备货",
  move: "迁移备货",
};

export async function printWarehouseTaskSheet(input: WarehouseTaskSheetInput) {
  if (!input.rows.length) throw new Error("作业单没有可打印的明细");
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.append(iframe);

  const printDocument = iframe.contentDocument;
  const printWindow = iframe.contentWindow;
  if (!printDocument || !printWindow) {
    iframe.remove();
    throw new Error("浏览器无法启动打印功能");
  }

  printDocument.open();
  printDocument.write(buildPrintDocument(input));
  printDocument.close();
  await printDocument.fonts?.ready;
  await new Promise<void>(resolve => window.setTimeout(resolve, 80));

  const removeFrame = () => window.setTimeout(() => iframe.remove(), 500);
  printWindow.addEventListener("afterprint", removeFrame, { once: true });
  printWindow.focus();
  printWindow.print();
  window.setTimeout(() => {
    if (iframe.isConnected) iframe.remove();
  }, 60_000);
}

export function buildPrintDocument(input: WarehouseTaskSheetInput) {
  const pages = chunk(input.rows, ROWS_PER_PAGE);
  const generatedAt = formatWarehouseTime(new Date(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const title = `内库 · ${TYPE_NAMES[input.type]}作业单`;
  const targetHeader = input.type === "pick" ? "主库位" : input.type === "move" ? "目标备货库位" : "备货库位";
  const sourceHeader = input.type === "store" ? "起始库位" : "备货库位";
  const body = pages.map((rows, pageIndex) => `
    <section class="sheet-page">
      <header>
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">
          <span>任务号：<strong>${escapeHtml(input.taskId)}</strong></span>
          <span>日期（美东）：<strong>${escapeHtml(generatedAt)}</strong></span>
          <span>页码：<strong>${pageIndex + 1} / ${pages.length}</strong></span>
        </div>
      </header>
      <table>
        <colgroup>
          <col class="sku-column">
          <col class="location-column">
          <col class="location-column">
          <col class="result-column">
          <col class="note-column">
        </colgroup>
        <thead><tr>
          <th>SKU</th>
          <th>${sourceHeader}</th>
          <th>${targetHeader}</th>
          <th>作业结果</th>
          <th>备注</th>
        </tr></thead>
        <tbody>
          ${rows.map(row => `<tr>
            <td class="sku">${escapeHtml(row.sku)}</td>
            <td class="location">${escapeHtml(row.fromLocation)}</td>
            <td class="location">${escapeHtml(row.toLocation)}</td>
            <td>${resultChoices(input.type)}</td>
            <td>${escapeOptionalHtml(row.note)}</td>
          </tr>`).join("")}
          ${Array.from({ length: ROWS_PER_PAGE - rows.length }, () => `<tr class="blank-row"><td></td><td></td><td></td><td></td><td></td></tr>`).join("")}
        </tbody>
      </table>
    </section>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(`内库-${TYPE_NAMES[input.type]}作业单-${input.taskId}`)}</title>
  <style>
    @page { size: Letter landscape; margin: 0.35in 0.4in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13pt; }
    .sheet-page { break-after: page; page-break-after: always; min-height: 7.8in; }
    .sheet-page:last-child { break-after: auto; page-break-after: auto; }
    header { margin: 0 0 0.18in; }
    h1 { margin: 0 0 0.13in; font-size: 25pt; line-height: 1.15; font-weight: 800; text-align: left; }
    .meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: baseline; gap: 0.25in; border-bottom: 1.5pt solid #000; padding-bottom: 0.1in; font-size: 12.5pt; }
    .meta span:nth-child(2) { text-align: center; }
    .meta span:last-child { text-align: right; white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .sku-column { width: 18%; }
    .location-column { width: 17%; }
    .result-column { width: 31%; }
    .note-column { width: 17%; }
    th, td { border: 1.25pt solid #000; color: #000; vertical-align: middle; }
    th { height: 0.45in; padding: 0.06in; background: #fff; font-size: 14pt; font-weight: 800; text-align: center; }
    td { height: 0.58in; padding: 0.07in 0.08in; font-size: 15.5pt; font-weight: 650; overflow-wrap: anywhere; }
    td.sku { font-size: 18pt; font-weight: 800; }
    td.location { font-size: 17pt; font-weight: 750; text-align: center; }
    .result-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: center; gap: 0.05in; }
    .choice { display: inline-flex; align-items: center; gap: 0.035in; font-size: 11pt; font-weight: 700; white-space: nowrap; }
    .box { display: inline-block; width: 0.17in; height: 0.17in; flex: 0 0 0.17in; border: 1.25pt solid #000; background: #fff; }
    .simple-result { justify-content: center; grid-template-columns: repeat(2, auto); gap: 0.24in; }
    .blank-row td { color: #000; }
    @media screen {
      body { background: #d9d9d9; padding: 16px; }
      .sheet-page { width: 10.2in; margin: 0 auto 16px; background: #fff; padding: 0; }
    }
    @media print {
      body { background: #fff; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function resultChoices(type: WarehouseTaskSheetType) {
  if (type !== "pick") {
    return `<div class="result-choices simple-result"><span class="choice"><i class="box"></i>完成</span><span class="choice"><i class="box"></i>退回</span></div>`;
  }
  return `<div class="result-choices"><span class="choice"><i class="box"></i>全部取出</span><span class="choice"><i class="box"></i>部分取出</span><span class="choice"><i class="box"></i>退回备货</span></div>`;
}

function escapeHtml(value: string) {
  return (value.trim() || "-").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function escapeOptionalHtml(value?: string) {
  const normalized=value?.trim()??"";
  return normalized?escapeHtml(normalized):"";
}

function chunk<T>(values: T[], size: number) {
  const pages: T[][] = [];
  for (let index = 0; index < values.length; index += size) pages.push(values.slice(index, index + size));
  return pages;
}
