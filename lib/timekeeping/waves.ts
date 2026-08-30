export type ParsedWave={barcode:string;code:string;waveNo:string;name:string;client:string;channelName:string;channelType:string;workType:"wave";skuCount:number;orderCount:number;pieceCount:number};
export const WAVE_TYPE_DEFINITIONS=[{name:"爆品",short:"爆",key:"hot"},{name:"单件",short:"单",key:"single"},{name:"多件",short:"多",key:"multiple"},{name:"混件",short:"混",key:"mixed"}] as const;
const WAVE_TYPES=WAVE_TYPE_DEFINITIONS.map(item=>item.name);
const WAVE_NUMBER_PATTERN=/^W[A-Z0-9-]{8,}$/;

export function parseWaveText(text:string):ParsedWave[]{
  const seen=new Set<string>();
  return text.split(/\r?\n/).filter(line=>line.trim()).flatMap(line=>{
    const row=splitDelimited(line,line.includes("\t")?"\t":",");
    const index=row.findIndex(cell=>WAVE_NUMBER_PATTERN.test(cell.trim().toUpperCase()));
    if(index<0)return [];
    const waveNo=row[index].trim().toUpperCase();
    if(seen.has(waveNo))return [];
    seen.add(waveNo);
    const channelRaw=row.slice(0,index).find(cell=>cell.trim())?.trim()??"其他";
    const trailing=row.slice(index+1).map(cell=>cell.trim());
    const typeIndex=trailing.findIndex(cell=>cell&&!isNumericCell(cell));
    const counts=(typeIndex>=0?trailing.slice(typeIndex+1):trailing).filter(isNumericCell);
    const channel=splitChannel(channelRaw,typeIndex>=0?trailing[typeIndex]:"");
    return [{barcode:waveNo,code:waveNo,waveNo,name:`${channel.name} · ${channel.type}`,client:channel.name,channelName:channel.name,channelType:channel.type,workType:"wave",skuCount:normalizeCount(counts[0]),orderCount:normalizeCount(counts[1]),pieceCount:normalizeCount(counts[2])}];
  });
}

export function splitChannel(value:unknown,fallbackType:unknown=""){
  const text=String(value??"").normalize("NFKC").replace(/paper/gi,"").trim();
  const compact=text.replace(/\s+/g,"");
  const type=WAVE_TYPES.find(item=>compact.endsWith(item));
  const fallback=normalizeWorkType(fallbackType);
  return {name:type?text.replace(new RegExp(`${type}\\s*$`,"u"),"").trim()||"其他":text||"其他",type:type||fallback||"未标注"};
}
export function normalizeWorkType(value:unknown){const normalized=String(value??"").normalize("NFKC").replace(/paper/gi,"").replace(/\s+/g,"").trim();return WAVE_TYPES.find(type=>normalized.includes(type))||normalized}
export function normalizeWaveCode(value:unknown){return String(value??"").normalize("NFKC").trim().toUpperCase().replace(/\s+/g,"-").slice(0,64)}
export function normalizeCount(value:unknown){const number=Number(String(value??"").replace(/,/g,""));return Number.isFinite(number)?Math.max(0,Math.min(10_000_000,Math.round(number))):0}
function splitDelimited(line:string,delimiter:string){const cells:string[]=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const char=line[i];if(char==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++}else quoted=!quoted}else if(char===delimiter&&!quoted){cells.push(value.trim());value=""}else value+=char}cells.push(value.trim());return cells}
function isNumericCell(value:string){return /^\d[\d,]*$/.test(value.trim())}
