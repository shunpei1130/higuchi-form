import { and, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { higuchiProspectRecords } from "./catalogueSchema";
import { ProductError } from "./state";

export type ProspectSearchInput = { query?: string; terms?: string[]; regions?: string[]; roles?: string[]; companySizes?: string[]; limit?: number };
export type EmployeeRange = { min: number | null; max: number | null };
const clean = (value: string) => value.normalize("NFKC").trim();
const distinct = (items: string[]) => [...new Set(items.filter(Boolean))];
const JAPAN_LOCATIONS = ["日本", "japan", "北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島", "茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川", "新潟", "富山", "石川", "福井", "山梨", "長野", "岐阜", "静岡", "愛知", "三重", "滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山", "鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知", "福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島", "沖縄", "hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki", "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui", "yamanashi", "nagano", "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara", "wakayama", "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime", "kochi", "fukuoka", "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa", "yokohama", "nagoya", "kobe", "sendai", "sapporo"];
const ROLE_GROUPS = [
  ["代表", "代表取締役", "社長", "経営者", "創業者", "ceo", "chief executive officer", "founder", "co-founder", "owner", "president"],
  ["営業責任者", "営業部長", "営業統括", "head of sales", "sales director", "sales manager", "vp sales", "vp of sales"],
  ["マーケティング責任者", "マーケティング部長", "head of marketing", "marketing director", "cmo", "chief marketing officer"],
  ["技術責任者", "開発責任者", "cto", "chief technology officer", "head of engineering", "engineering director"],
  ["財務責任者", "経理部長", "cfo", "chief financial officer", "finance director"],
];
const normalizedKey = (value: string) => clean(value).toLowerCase().replace(/[\s・._-]/g, "");

export function parseEmployeeRanges(values: string[] = []): EmployeeRange[] {
  return values.slice(0, 10).flatMap<EmployeeRange>(input => {
    let value = clean(input).toLowerCase().replace(/[,，]/g, "").replace(/[〜～–—−]/g, "-");
    if (!value || /^(?:不問|指定なし|要確認|all|any|すべて)$/.test(value)) return [];
    value = value.replace(/(\d+(?:\.\d+)?)k\b/g, (_, digits: string) => String(Number(digits) * 1000));
    const values = value.match(/\d+/g)?.map(Number) ?? [];
    if (!values.length || values.length > 2 || values.some(number => !Number.isSafeInteger(number) || number > 2_000_000_000)) throw new ProductError("会社規模は「10-100」「100+」のように人数で指定してください。");
    const [first, second] = values;
    if (second !== undefined) {
      if (!/(?:-|\bto\b)/.test(value) || first > second) throw new ProductError("会社規模の範囲を確認してください。");
      return [{ min: first, max: second }];
    }
    if (/(?:以下|以内|at most|<=|≤)/.test(value)) return [{ min: null, max: first }];
    if (/(?:未満|under|less than|below|<)/.test(value)) return [{ min: null, max: first - 1 }];
    if (/(?:超|over|more than|above|>)/.test(value) && !/(?:以上|>=|≥)/.test(value)) return [{ min: first + 1, max: null }];
    if (/(?:\+|以上|at least|>=|≥)/.test(value)) return [{ min: first, max: null }];
    return [{ min: first, max: first }];
  });
}

export function normalizeProspectSearch(input: ProspectSearchInput) {
  const requestedRegions = distinct((input.regions ?? []).slice(0, 10).flatMap(value => clean(value).split(/[,、;|]/).map(clean)));
  const japan = requestedRegions.some(value => /^(?:日本|日本国内|国内|japan|jp|jpn)$/i.test(value));
  const regions = distinct(requestedRegions.flatMap(value => /^(?:日本|日本国内|国内|japan|jp|jpn)$/i.test(value) ? JAPAN_LOCATIONS : [value])).map(value => value.slice(0, 100));
  const roles = distinct((input.roles ?? []).slice(0, 10).flatMap(value => clean(value).split(/[,、;|/・]/).flatMap(role => {
    const group = ROLE_GROUPS.find(aliases => aliases.some(alias => normalizedKey(alias) === normalizedKey(role)));
    return group ?? [clean(role).slice(0, 100)];
  })));
  const terms = distinct([...(input.terms ?? []).slice(0, 10), ...(input.query ?? "").split(/[\s,、;|]+/)].map(value => clean(value).slice(0, 80)).filter(value => value.length > 1)).slice(0, 12);
  const requestedLimit = input.limit ?? 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, Math.floor(requestedLimit))) : 20;
  return { terms, regions, japan, roles, ranges: parseEmployeeRanges(input.companySizes), limit };
}

export function prospectPattern(value: string): string { return `%${value.replace(/[\\%_]/g, char => `\\${char}`)}%`; }

/** Business filters match company metadata; a person row may omit the company description or employee count. */
export function prospectSearchConditions(input: ProspectSearchInput): SQL | undefined {
  const search = normalizeProspectSearch(input), metadata = alias(higuchiProspectRecords, "prospect_company_metadata");
  const textMatch = search.terms.length ? or(...search.terms.flatMap(term => [ilike(metadata.companyName, prospectPattern(term)), ilike(metadata.description, prospectPattern(term)), sql`exists (select 1 from jsonb_each_text(${metadata.extra}) as industry_attribute(key,value) where lower(industry_attribute.key) ~ 'industry|sector|business|category|業種|業界|産業|事業|カテゴリ' and industry_attribute.value ilike ${prospectPattern(term)})`])) : undefined;
  const regionMatch = search.regions.length ? or(...search.regions.map(region => ilike(metadata.location, prospectPattern(region))), ...(search.japan ? [sql`lower(${metadata.location}) ~ '(^|[^a-z])(jp|jpn)([^a-z]|$)'`] : [])) : undefined;
  const sizeMatch = search.ranges.length ? or(...search.ranges.map(range => and(range.min !== null ? sql`${metadata.employeeCount} >= ${range.min}` : undefined, range.max !== null ? sql`${metadata.employeeCount} <= ${range.max}` : undefined))) : undefined;
  const companyMatch = textMatch || regionMatch || sizeMatch ? sql`(${higuchiProspectRecords.datasetId}, lower(coalesce(nullif(${higuchiProspectRecords.domain}, ''), ${higuchiProspectRecords.companyName}))) in (select ${metadata.datasetId}, lower(coalesce(nullif(${metadata.domain}, ''), ${metadata.companyName})) from ${higuchiProspectRecords} ${metadata} where ${and(textMatch, regionMatch, sizeMatch)})` : undefined;
  const roleMatch = search.roles.length ? or(eq(higuchiProspectRecords.name, ""), ...search.roles.map(role => ilike(higuchiProspectRecords.role, prospectPattern(role)))) : undefined;
  return and(companyMatch, roleMatch);
}
