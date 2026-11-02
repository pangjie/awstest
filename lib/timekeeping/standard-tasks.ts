// Array order is the fixed-task button order; statistics keep their established order.
export const STANDARD_TASKS = [
  {code:"SCAN",barcode:"JOB-SCAN",name:"混件扫描",icon:"scan",color:"#8863c9",statisticsOrder:2},
  {code:"SINGLE-SCAN",barcode:"JOB-SINGLE-SCAN",name:"单件扫描",icon:"scan",color:"#21a6a1",statisticsOrder:1},
  {code:"TODO",barcode:"JOB-TODO",name:"问题单",icon:"issue",color:"#e6a23b",statisticsOrder:3},
  {code:"WAREHOUSE",barcode:"JOB-WAREHOUSE",name:"仓务",icon:"warehouse",color:"#4b9b68",statisticsOrder:4},
  {code:"PUTAWAY",barcode:"JOB-PUTAWAY",name:"上架",icon:"putaway",color:"#c66c39",statisticsOrder:5},
  {code:"LOCATION-MAINTENANCE",barcode:"JOB-LOCATION-MAINTENANCE",name:"库维",icon:"maintenance",color:"#52859a",statisticsOrder:6},
  {code:"CLEAN",barcode:"JOB-CLEAN",name:"清洁",icon:"clean",color:"#d57887",statisticsOrder:7},
] as const;
