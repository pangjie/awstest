export const EMPLOYEE_ID_ALPHABET="34679CFHKMNRVWXY";
export const EMPLOYEE_ID_LENGTH=8;
export const LEGACY_EMPLOYEE_ID_LENGTH=4;

export function sanitizeEmployeeId(value:string){
  return [...value.normalize("NFKC").toUpperCase()].filter(character=>EMPLOYEE_ID_ALPHABET.includes(character)).join("").slice(0,EMPLOYEE_ID_LENGTH);
}

export function isValidEmployeeId(value:string){
  return (value.length===EMPLOYEE_ID_LENGTH||value.length===LEGACY_EMPLOYEE_ID_LENGTH)&&[...value].every(character=>EMPLOYEE_ID_ALPHABET.includes(character));
}

export async function generateEmployeeId(name:string,type:"OZM"|"JJC",taken:ReadonlySet<string>,length=EMPLOYEE_ID_LENGTH){
  const normalized=name.normalize("NFKC").trim().toUpperCase();
  const encoder=new TextEncoder();
  for(let collision=0;collision<4096;collision++){
    const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(`${type}\0${normalized}\0${collision}`)));
    const id=Array.from(digest.slice(0,length),value=>EMPLOYEE_ID_ALPHABET[value&15]).join("");
    if(!taken.has(id))return id;
  }
  throw new Error("员工 ID 空间暂时无法分配，请稍后重试");
}
