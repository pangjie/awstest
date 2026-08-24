import ExcelJS from "exceljs";

function cellValue(value:ExcelJS.CellValue):unknown {
  if(value===null||value===undefined)return null;
  if(value instanceof Date)return value.toISOString();
  if(typeof value!=="object")return value;
  if("result" in value)return cellValue(value.result as ExcelJS.CellValue);
  if("richText" in value)return value.richText.map(part=>part.text).join("");
  if("text" in value)return value.text;
  return String(value);
}

function worksheetData(worksheet:ExcelJS.Worksheet) {
  const width=Math.max(worksheet.columnCount,worksheet.getRow(1).cellCount);
  const headers=Array.from({length:width},(_,index)=>cellValue(worksheet.getCell(1,index+1).value));
  const rows:Array<Record<string,unknown>>=[];
  worksheet.eachRow({includeEmpty:false},(row,rowNumber)=>{
    if(rowNumber===1)return;
    const record:Record<string,unknown>={};
    let meaningful=false;
    headers.forEach((header,index)=>{
      const key=header===null?"":String(header).trim();
      if(!key)return;
      const value=cellValue(row.getCell(index+1).value);
      record[key]=value;
      if(value!==null&&String(value).trim()!=="")meaningful=true;
    });
    if(meaningful)rows.push(record);
  });
  return {headers,rows};
}

export async function readFirstWorksheet(source:ArrayBuffer) {
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(source);
  const worksheet=workbook.worksheets[0];
  if(!worksheet)throw new Error("Excel 中没有可读取的工作表");
  return worksheetData(worksheet);
}

export async function readNamedWorksheet(source:ArrayBuffer,sheetName:string) {
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(source);
  const worksheet=workbook.getWorksheet(sheetName);
  if(!worksheet)throw new Error(`Excel 中缺少“${sheetName}”工作表`);
  return worksheetData(worksheet);
}

export async function downloadWorksheet(input:{
  rows:Array<Array<string|number>>;
  sheetName:string;
  fileName:string;
  widths?:number[];
  autoFilter?:string;
}) {
  await downloadWorkbook({fileName:input.fileName,sheets:[input]});
}

export async function downloadWorkbook(input:{
  sheets:Array<{
    rows:Array<Array<string|number>>;
    sheetName:string;
    widths?:number[];
    autoFilter?:string;
  }>;
  fileName:string;
}) {
  const workbook=new ExcelJS.Workbook();
  for(const sheet of input.sheets) {
    const worksheet=workbook.addWorksheet(sheet.sheetName);
    worksheet.addRows(sheet.rows);
    sheet.widths?.forEach((width,index)=>{worksheet.getColumn(index+1).width=width});
    if(sheet.autoFilter)worksheet.autoFilter=sheet.autoFilter;
    worksheet.views=[{state:"frozen",ySplit:1}];
  }
  const output=await workbook.xlsx.writeBuffer();
  const blob=new Blob([output],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const url=URL.createObjectURL(blob),anchor=document.createElement("a");
  anchor.href=url;anchor.download=input.fileName;anchor.click();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
