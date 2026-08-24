export type LocationSearchItem={code:string};

export function normalizeLocationSearch(value:string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[—–_/\s]+/g,"-")
    .replace(/-+/g,"-");
}

function locationMatchScore(code:string,query:string) {
  const normalizedCode=normalizeLocationSearch(code);
  const normalizedQuery=normalizeLocationSearch(query);
  if(!normalizedQuery)return -1;
  if(normalizedCode===normalizedQuery)return 0;

  const codeParts=normalizedCode.split("-").filter(Boolean);
  const queryParts=normalizedQuery.split("-").filter(Boolean);
  const matchesFrom=(start:number)=>queryParts.every((part,index)=>{
    const codePart=codeParts[start+index];
    if(!codePart)return false;
    const isLastQueryPart=index===queryParts.length-1;
    const reachesCodeEnd=start+queryParts.length===codeParts.length;
    return isLastQueryPart&&reachesCodeEnd?codePart.startsWith(part):codePart===part;
  });
  if(matchesFrom(0))return 1;
  if(/^\d/.test(queryParts[0]??"")&&codeParts.some((_,start)=>start>0&&matchesFrom(start)))return 2;

  if(!/[-—–_/\s]/.test(query.trim())) {
    const compactCode=normalizedCode.replaceAll("-","");
    const compactQuery=normalizedQuery.replaceAll("-","");
    if(compactCode.startsWith(compactQuery))return 3;
    if(compactCode.includes(compactQuery))return 4;
  }
  return -1;
}

export function findLocationMatches<T extends LocationSearchItem>(locations:T[],query:string,limit=12) {
  return locations
    .map(location=>({location,score:locationMatchScore(location.code,query)}))
    .filter(result=>result.score>=0)
    .sort((left,right)=>left.score-right.score||left.location.code.localeCompare(right.location.code,"zh-CN",{numeric:true}))
    .slice(0,limit)
    .map(result=>result.location);
}
