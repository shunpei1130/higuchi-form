import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { higuchiProspectDatasets, higuchiProspectRecords } from "./catalogueSchema";
import { catalogCompanyId, normalizeCatalogRows, type CatalogCompany, type CatalogPerson } from "./catalogueContract";
import { ProductError } from "./state";
import { normalizeProspectSearch, prospectSearchConditions, type ProspectSearchInput } from "./prospectFilters";
export type { CatalogCompany, CatalogPerson } from "./catalogueContract";

export async function importProspectDataset(input:{name:string;source:"csv"|"xlsx"|"database";createdBy:string;rows:Record<string,unknown>[]}):Promise<{id:string;rowCount:number;published:false}>{
  const name=input.name.trim().slice(0,150);if(!name)throw new ProductError("データ名を指定してください。");const rows=normalizeCatalogRows(input.rows);
  return db.transaction(async tx=>{const [dataset]=await tx.insert(higuchiProspectDatasets).values({name,source:input.source,createdBy:input.createdBy,rowCount:rows.length,published:false}).returning();
    for(let offset=0;offset<rows.length;offset+=250)await tx.insert(higuchiProspectRecords).values(rows.slice(offset,offset+250).map(row=>({...row,datasetId:dataset.id})));
    return {id:dataset.id,rowCount:rows.length,published:false};});
}
export async function listProspectDatasets(){return db.select({id:higuchiProspectDatasets.id,name:higuchiProspectDatasets.name,source:higuchiProspectDatasets.source,published:higuchiProspectDatasets.published,rowCount:higuchiProspectDatasets.rowCount,revision:higuchiProspectDatasets.revision,createdAt:higuchiProspectDatasets.createdAt}).from(higuchiProspectDatasets).orderBy(sql`${higuchiProspectDatasets.createdAt} desc`).limit(100);}
export async function publishProspectDataset(id:string,published:boolean){if(!/^[a-f0-9-]{36}$/i.test(id))throw new ProductError("データが見つかりません。",404);const [row]=await db.update(higuchiProspectDatasets).set({published,revision:sql`${higuchiProspectDatasets.revision}+1`}).where(eq(higuchiProspectDatasets.id,id)).returning({id:higuchiProspectDatasets.id,published:higuchiProspectDatasets.published});if(!row)throw new ProductError("データが見つかりません。",404);return row;}
export async function searchPublishedProspects(input:ProspectSearchInput):Promise<{available:boolean;datasetRevision:string;companies:CatalogCompany[];people:CatalogPerson[]}>{
  const datasets=await db.select({id:higuchiProspectDatasets.id,revision:higuchiProspectDatasets.revision}).from(higuchiProspectDatasets).where(eq(higuchiProspectDatasets.published,true)).orderBy(higuchiProspectDatasets.id);
  if(!datasets.length)return {available:false,datasetRevision:"",companies:[],people:[]};
  const {limit}=normalizeProspectSearch(input);
  const rows=await db.select({record:higuchiProspectRecords,source:higuchiProspectDatasets.source}).from(higuchiProspectRecords).innerJoin(higuchiProspectDatasets,eq(higuchiProspectDatasets.id,higuchiProspectRecords.datasetId)).where(and(eq(higuchiProspectDatasets.published,true),prospectSearchConditions(input))).orderBy(sql`case when ${higuchiProspectRecords.name} <> '' then 0 else 1 end`,higuchiProspectRecords.id).limit(Math.min(2000,limit*20));
  const companies=new Map<string,CatalogCompany>(),people:CatalogPerson[]=[];
  for(const {record:r,source}of rows){const companyId=catalogCompanyId(r.domain,r.companyName);if(!companies.has(companyId)&&companies.size<limit)companies.set(companyId,{id:companyId,name:r.companyName,domain:r.domain,description:r.description,location:r.location,employeeCount:r.employeeCount,monthlyTraffic:r.monthlyTraffic,trafficGrowth:r.trafficGrowth,sourceUrl:r.sourceUrl});const company=companies.get(companyId);if(company){company.description ||=r.description;company.location ||=r.location;company.employeeCount??=r.employeeCount;company.monthlyTraffic??=r.monthlyTraffic;company.trafficGrowth??=r.trafficGrowth;company.sourceUrl ||=r.sourceUrl;}if(company&&r.name&&people.length<limit)people.push({id:r.id,companyId,name:r.name,role:r.role,email:r.email,verification:["valid","invalid","catch_all"].includes(r.verification)?r.verification as CatalogPerson["verification"]:"unknown",location:r.location,sourceUrl:r.sourceUrl,sourceLabel:source==="database"?"データベース":source==="xlsx"?"Excel":"CSV"});}
  return {available:true,datasetRevision:createHash("sha256").update(JSON.stringify(datasets)).digest("hex").slice(0,24),companies:[...companies.values()],people};
}
