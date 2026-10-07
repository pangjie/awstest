import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import ts from "typescript";
const require=createRequire(import.meta.url);
const root=path.resolve(import.meta.dirname,"../..");
export function exportLoader(overrides={}){
  const cache=new Map();
  function load(file){
    const absolute=path.resolve(root,file);
    if(cache.has(absolute))return cache.get(absolute);
    const exports={};cache.set(absolute,exports);
    const code=ts.transpileModule(fs.readFileSync(absolute,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const resolve=(name)=>{if(Object.hasOwn(overrides,name))return overrides[name];if(name.startsWith(".")||name.startsWith("@/")){const target=name.startsWith("@/")?path.resolve(root,name.slice(2)):path.resolve(path.dirname(absolute),name);return load(target+".ts")}return require(name)};
    new Function("exports","require",code)(exports,resolve);
    return exports;
  }
  return load;
}
