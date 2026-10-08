import ExcelJS from "exceljs";
import { setImmediate } from "node:timers/promises";
import { PassThrough } from "node:stream";
import type { ExportWave } from "./wave-export-data";
import { ExportError, EXPORT_LIMITS, type ExportQuery } from "./wave-export-contract";

export function exportMetadata(query:ExportQuery,generatedAt:string,count:number){
  return {version:1,timeZone:"America/New_York",date:query.date,durationBasis:"lifetime" as const,generatedAt,count};
}
const localTimeFormatter=new Intl.DateTimeFormat("sv-SE",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",timeZoneName:"shortOffset"});
function localTime(iso:string|null){
  if(!iso)return "";
  return localTimeFormatter.format(new Date(iso));
}
function utcTime(iso:string|null){
  return iso?new Date(iso).toISOString().replace(/\.\d{3}Z$/,"Z"):"";
}
export async function buildWaveWorkbook(rows:ExportWave[],metadata:ReturnType<typeof exportMetadata>,checkpoint=()=>{}){
  const stream=new PassThrough();
  let chunks:Buffer[]=[],size=0;
  stream.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size<=EXPORT_LIMITS.bytes)chunks.push(chunk);else chunks=[]});
  const book=new ExcelJS.stream.xlsx.WorkbookWriter({stream,useStyles:true,useSharedStrings:false});
  const sheet=book.addWorksheet("波次数据",{views:[{state:"frozen",ySplit:1}]});
  try{
  const headers=["渠道","类型","波次号","状态","SKU","订单","件数","姓名","协同人员","开始时间","完结时间","用时","时效","记录状态"];
  sheet.addRow(headers);
  [14,12,24,12,10,10,10,20,40,32,32,18,12,12].forEach((width,i)=>{sheet.getColumn(i+1).width=width});
  sheet.getColumn(12).numFmt="[h]:mm:ss";
  sheet.getColumn(13).numFmt="0";
  sheet.autoFilter={from:"A1",to:`N${Math.max(1,rows.length+1)}`};
  sheet.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};sheet.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF234E70"}};
  sheet.getRow(1).commit();
  for(const [index,row] of rows.entries()){
    if(index%250===0){await setImmediate();checkpoint()}
    sheet.addRow([row.channel,row.type,row.waveNo,row.statusLabel,row.skuCount,row.orderCount,row.pieceCount,row.lead??"",row.helpers.join("、"),utcTime(row.startedAt),utcTime(row.completedAt),row.totalMs/86400000,row.hourlyPieces,row.recordStatus]).commit();
  }
  sheet.commit();
  const notes=book.addWorksheet("导出说明");
  notes.columns=[{width:22},{width:100}];
  const noteRows=[["项目","内容"],["格式版本",metadata.version],["日期",metadata.date],["日期依据","创建日期"],["日期筛选时区",metadata.timeZone],["导出时间",localTime(metadata.generatedAt)],["波次数量",metadata.count],["工时口径","所选波次截至导出时刻的完整累计有效人工工时，含负责人和协同，不含不在岗时间"],["时效口径","件数 ÷ 累计工时小时数，四舍五入为整数；工时为零则留空"],["时间说明","开始时间、完结时间为 UTC 零时区 ISO 8601 文本（Z 结尾，精确到秒）；日期筛选和导出时间仍为美东时间；进行中数据以导出时间为准"],["行顺序","波次添加顺序"],["空数据","无匹配波次时仍保留表头；不静默截断数据"]];
  for(const values of noteRows)notes.addRow(values);
  notes.getRow(1).font={bold:true};notes.getColumn(2).alignment={wrapText:true,vertical:"top"};
  notes.commit();
  }finally{
    // Flush/close even when a deadline interrupts row writing; never return a partial workbook.
    await book.commit();
  }
  if(size>EXPORT_LIMITS.bytes)throw new ExportError(422,"FILE_TOO_LARGE","Maximum file size is 20 MiB");
  return Buffer.concat(chunks);
}
