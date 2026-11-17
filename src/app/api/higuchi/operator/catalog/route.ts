import { withOrgContext, requirePlatformOperator } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/higuchi/service";
import { productErrorResponse } from "@/lib/higuchi/http";
import { ProductError } from "@/lib/higuchi/state";
import { catalogCsvRows } from "@/lib/higuchi/catalogueContract";
import { importProspectDataset, listProspectDatasets, publishProspectDataset } from "@/lib/higuchi/prospectCatalog";
export const runtime="nodejs";
export const maxDuration=120;
export async function GET(request:Request){try{return await withOrgContext(request,async ctx=>{await requirePlatformOperator(ctx);return Response.json({datasets:await listProspectDatasets()},{headers:{"Cache-Control":"no-store"}});});}catch(error){return productErrorResponse(error);}}
export async function POST(request:Request){try{assertSameOrigin(request);return await withOrgContext(request,async ctx=>{
  await requirePlatformOperator(ctx);
  if(Number(request.headers.get("content-length")??0)>5_500_000)throw new ProductError("取り込みファイルは5MB以内で指定してください。",413);
  if(request.headers.get("content-type")?.includes("multipart/form-data")){
    const form=await request.formData(),file=form.get("file");if(!(file instanceof File)||file.size>5_000_000||file.size===0)throw new ProductError("5MB以内のCSVまたはExcelを指定してください。");
    const name=String(form.get("name")??file.name).trim();let rows:Record<string,unknown>[],source:"csv"|"xlsx";
    if(/\.csv$/i.test(file.name)){rows=catalogCsvRows(await file.text());source="csv";}
    else if(/\.xlsx$/i.test(file.name)){
      const XLSX=await import("xlsx");const book=XLSX.read(await file.arrayBuffer(),{type:"array",cellFormula:false,cellHTML:false,cellStyles:false,sheetRows:10002});
      const sheet=book.Sheets[book.SheetNames[0]];if(!sheet)throw new ProductError("最初のシートにデータを指定してください。");
      rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(sheet,{defval:"",raw:false});source="xlsx";
    }else throw new ProductError("CSVまたは.xlsxを指定してください。");
    const result=await importProspectDataset({name,source,createdBy:ctx.userId,rows});return Response.json(result,{status:201,headers:{"Cache-Control":"no-store"}});
  }
  const buffer=await request.arrayBuffer();if(buffer.byteLength>5_000_000)throw new ProductError("取り込みデータは5MB以内で指定してください。",413);
  let body:Record<string,unknown>;try{body=JSON.parse(new TextDecoder().decode(buffer));}catch{throw new ProductError("JSONデータを確認してください。");}
  if(!body||Array.isArray(body)||typeof body!=="object")throw new ProductError("操作を指定してください。");
  if(body.action==="publish"){
    if(typeof body.datasetId!=="string"||typeof body.published!=="boolean")throw new ProductError("対象データと公開状態を指定してください。");
    return Response.json(await publishProspectDataset(body.datasetId,body.published),{headers:{"Cache-Control":"no-store"}});
  }
  if(body.action==="import"&&typeof body.name==="string"&&Array.isArray(body.rows)&&body.rows.every(row=>row&&typeof row==="object"&&!Array.isArray(row)))return Response.json(await importProspectDataset({name:body.name,source:"database",createdBy:ctx.userId,rows:body.rows}),{status:201,headers:{"Cache-Control":"no-store"}});
  throw new ProductError("データの取り込み、または公開状態を指定してください。");
});}catch(error){return productErrorResponse(error);}}
