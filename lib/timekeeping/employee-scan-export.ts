import bwipjs from "bwip-js/node";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import sharp from "sharp";
import { workDate } from "./time";

export type ScanExportEmployee={badgeCode:string;name:string;type:string;active:boolean};

const QR_PNG_SIZE=600;
const BARCODE_PNG_WIDTH=1200;
const BARCODE_PNG_HEIGHT=300;

export async function createEmployeeScanExport(employees:ScanExportEmployee[],generatedAt=new Date()){
  if(!employees.length)throw new Error("当前没有可导出的员工");
  const assets=[];
  for(const employee of employees)assets.push(await createEmployeeAssets(employee));
  const workbook=await createWorkbook(assets,generatedAt);
  const zip=new JSZip();
  const date=dateKey(generatedAt);
  zip.file(`内库员工扫描名册-${date}.xlsx`,workbook);
  zip.file("使用说明.txt",exportGuide(employees.length,generatedAt));
  for(const asset of assets){
    const stem=`${asset.employee.badgeCode}-${safeFileName(asset.employee.name)}`;
    zip.file(`条码-PNG/${stem}.png`,asset.barcodePng);
    zip.file(`条码-SVG/${stem}.svg`,asset.barcodeSvg);
    zip.file(`二维码-PNG/${stem}.png`,asset.qrPng);
    zip.file(`二维码-SVG/${stem}.svg`,asset.qrSvg);
  }
  return {
    buffer:await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE",compressionOptions:{level:6}}),
    fileName:`内库员工扫描素材-${date}.zip`,
  };
}

async function createEmployeeAssets(employee:ScanExportEmployee){
  const options={text:employee.badgeCode,backgroundcolor:"FFFFFF"};
  const [barcodeRaw,qrRaw]=await Promise.all([
    bwipjs.toBuffer({bcid:"code128",...options,scale:6,height:12.7}),
    bwipjs.toBuffer({bcid:"qrcode",...options,scale:10}),
  ]);
  const [barcodePng,qrPng]=await Promise.all([
    centerOnWhiteCanvas(barcodeRaw,BARCODE_PNG_WIDTH,BARCODE_PNG_HEIGHT),
    centerOnWhiteCanvas(qrRaw,QR_PNG_SIZE,QR_PNG_SIZE),
  ]);
  return {
    employee,
    barcodePng,
    qrPng,
    barcodeSvg:addQuietZone(bwipjs.toSVG({bcid:"code128",text:employee.badgeCode}),20,10),
    qrSvg:addQuietZone(bwipjs.toSVG({bcid:"qrcode",text:employee.badgeCode}),16,16),
  };
}

async function centerOnWhiteCanvas(source:Buffer,width:number,height:number){
  const metadata=await sharp(source).metadata();
  const sourceWidth=metadata.width??0,sourceHeight=metadata.height??0;
  if(!sourceWidth||!sourceHeight||sourceWidth>width||sourceHeight>height)throw new Error("扫描图形尺寸生成失败");
  const left=Math.floor((width-sourceWidth)/2),top=Math.floor((height-sourceHeight)/2);
  return sharp(source).extend({
    left,right:width-sourceWidth-left,top,bottom:height-sourceHeight-top,
    background:{r:255,g:255,b:255,alpha:1},
  }).png({compressionLevel:9}).toBuffer();
}

function addQuietZone(svg:string,horizontal:number,vertical:number){
  const match=svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if(!match)throw new Error("SVG 扫描图形生成失败");
  const width=Number(match[1]),height=Number(match[2]);
  return svg
    .replace(match[0],`viewBox="${-horizontal} ${-vertical} ${width+horizontal*2} ${height+vertical*2}"`)
    .replace(/(<svg[^>]*>)/,`$1\n<rect x="${-horizontal}" y="${-vertical}" width="${width+horizontal*2}" height="${height+vertical*2}" fill="#fff"/>`);
}

async function createWorkbook(assets:Awaited<ReturnType<typeof createEmployeeAssets>>[],generatedAt:Date){
  const workbook=new ExcelJS.Workbook();
  workbook.creator="内库";
  workbook.created=generatedAt;
  workbook.modified=generatedAt;
  const sheet=workbook.addWorksheet("员工扫描名册",{
    views:[{state:"frozen",ySplit:1,showGridLines:false}],
    pageSetup:{orientation:"landscape",paperSize:9,fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.25,right:.25,top:.4,bottom:.4,header:.2,footer:.2}},
  });
  sheet.columns=[
    {header:"序号",key:"index",width:8},{header:"姓名",key:"name",width:18},{header:"组织",key:"type",width:10},
    {header:"状态",key:"status",width:10},{header:"员工 ID",key:"badgeCode",width:16},
    {header:"Code 128 条码",key:"barcode",width:38},{header:"二维码",key:"qr",width:16},
  ];
  sheet.autoFilter={from:"A1",to:`G${assets.length+1}`};
  sheet.getRow(1).height=28;
  sheet.getRow(1).eachCell(cell=>{
    cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF1F4E78"}};
    cell.font={bold:true,color:{argb:"FFFFFFFF"},size:11};
    cell.alignment={horizontal:"center",vertical:"middle"};
    cell.border={bottom:{style:"medium",color:{argb:"FF173A5A"}}};
  });
  assets.forEach((asset,index)=>{
    const row=sheet.addRow({index:index+1,name:asset.employee.name,type:asset.employee.type,status:asset.employee.active?"启用":"已停用",badgeCode:asset.employee.badgeCode});
    row.height=82;
    row.eachCell({includeEmpty:true},cell=>{
      cell.alignment={horizontal:cell.col==="B"||cell.col==="E"?"left":"center",vertical:"middle"};
      cell.font={name:"Arial",size:11,color:{argb:asset.employee.active?"FF1F2937":"FF7A8492"}};
      cell.border={bottom:{style:"thin",color:{argb:"FFDDE4ED"}}};
      if(index%2===1)cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF6F9FC"}};
    });
    row.getCell(2).font={...row.getCell(2).font,bold:true,size:12};
    row.getCell(5).font={...row.getCell(5).font,bold:true,name:"Consolas",size:12};
    const barcodeId=workbook.addImage({base64:`data:image/png;base64,${asset.barcodePng.toString("base64")}`,extension:"png"});
    const qrId=workbook.addImage({base64:`data:image/png;base64,${asset.qrPng.toString("base64")}`,extension:"png"});
    sheet.addImage(barcodeId,{tl:{col:5.15,row:row.number-1+.16},ext:{width:230,height:58}});
    sheet.addImage(qrId,{tl:{col:6.28,row:row.number-1+.08},ext:{width:76,height:76}});
  });
  sheet.headerFooter.oddFooter="&L内库员工扫描名册&C第 &P 页，共 &N 页&R仅限内部使用";
  const output=await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

function exportGuide(count:number,generatedAt:Date){
  return [
    "内库员工扫描素材",`生成时间：${generatedAt.toISOString()}`,`员工数量：${count}`,"",
    "1. Excel 名册包含姓名、组织、状态、8 位员工 ID，以及可直接扫描的条码和二维码。",
    "2. 条码和二维码编码内容完全相同，均为员工 ID，不包含账号、密码或权限信息。",
    "3. 条码 PNG 为 1200×300 px；二维码 PNG 为 600×600 px。",
    "4. SVG 为矢量母版，可用于工牌、标签和印刷排版，任意缩放不会失真。",
    "5. 文件含员工识别信息，请仅在内部使用并妥善保管。",
  ].join("\n");
}

function safeFileName(value:string){return value.normalize("NFKC").replace(/[\\/:*?"<>|\x00-\x1f]+/g,"-").trim().slice(0,60)||"员工"}
function dateKey(value:Date){return workDate(value)}
