import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    name: "内库 API",
    version: "1.8.0",
    baseUrl: "/api/v1",
    authentication: "内库内部账号会话；API 写操作需有效会话",
    resources: {
      pallets: {
        list: "GET /pallets?q=&location=&status=",
        inboundBatch: "POST /pallets/inbound",
        update: "PATCH /pallets/:palletId",
        history: "GET /pallets/:palletId/movements",
      },
      skus: {
        list: "GET /skus?q=",
        history: "GET /skus/:skuCode/movements",
      },
      skuCatalog: {
        list: "GET /sku-catalog?q=&page=&pageSize=",
        create: "POST /sku-catalog（action=create；手动新增并校验 SKU 是否重复）",
        import: "POST /sku-catalog（start / batch / finish 分批导入；前端只提交5个 SKU 主数据字段）",
      },
      locations: {
        list: "GET /locations?q=&type=reserve|pick&zone=&status=",
        create: "POST /locations",
        import: "POST /locations（action=import；按 code + type 新增或更新容量）",
        update: "PATCH /locations/:code?type=reserve|pick",
        history: "GET /locations/:code/history?type=reserve|pick&from=&to=&sku=",
      },
      tasks: {
        list: "GET /tasks",
        createPickOrMoveBatch: "POST /tasks",
        claim: "POST /tasks/:taskId/claim",
        complete: "POST /tasks/:taskId/complete（取备货需携带 palletId，逐托确认）",
        deleteEmptyBrokenPickTask: "DELETE /tasks/:taskId（admin；仅允许删除无子任务、无操作记录的异常取备货任务）",
      },
      movements: {
        list: "GET /movements?sku=&pallet=&location=&action=&operator=&from=&to=",
      },
      synchronization: {
        revision: "GET /revision（前端低频检查；版本变化时才刷新仓库数据）",
      },
      users: {
        list: "GET /users (admin)",
        create: "POST /users (admin)",
        update: "PATCH /users/:userId (admin)",
        deactivate: "DELETE /users/:userId (admin)",
      },
    },
    conventions: {
      palletId: "PYYMMDD-sequence",
      remarks: "商品名称与初始数量已合并为托盘备注说明；新记录只使用 remarks",
      partialPick: "部分取出不填写数量，托盘继续占用原备货库位，并记录 partial_pick 历史",
      pickItemNote: "创建取备货任务时，pickItems[] 可携带独立 note，最长 500 个字符",
      locationIdentity: "库位由 code + type 共同唯一标识；同名备货库位与拣货库位是不同记录",
      timestamps: "ISO 8601 UTC 存储；仓库界面、日期筛选、统计与打印统一按 America/New_York 美东时间",
      pagination: "GET /movements uses limit and offset",
    },
  });
}
