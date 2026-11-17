import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { normalizeProspectSearch, parseEmployeeRanges, prospectPattern, prospectSearchConditions } from "./prospectFilters";

describe("published prospect search conditions", () => {
  test("normalizes Japanese and English country and decision-maker aliases", () => {
    for (const region of ["日本", "JP", "Japan", "ＪＰ"]) {
      const search = normalizeProspectSearch({ regions: [region], roles: ["ＣＥＯ"] });
      expect(search.japan).toBe(true);
      expect(search.regions).toContain("東京");
      expect(search.regions).toContain("tokyo");
      expect(search.roles).toContain("代表取締役");
      expect(search.roles).toContain("chief executive officer");
    }
    const sales = normalizeProspectSearch({ regions: ["大阪"], roles: ["営業責任者"] });
    expect(sales.japan).toBe(false); expect(sales.roles).toContain("head of sales");
  });
  test("retains explicit employee ranges, optional limits and inclusive boundaries", () => {
    expect(parseEmployeeRanges(["従業員10〜100名", "1,001+", "50以下", "under 20", "over 500"])).toEqual([{ min: 10, max: 100 }, { min: 1001, max: null }, { min: null, max: 50 }, { min: null, max: 19 }, { min: 501, max: null }]);
    expect(parseEmployeeRanges(["不問", "要確認"])).toEqual([]);
    expect(() => parseEmployeeRanges(["100-10"])).toThrow();
    expect(() => parseEmployeeRanges(["中小企業"])).toThrow();
    expect(normalizeProspectSearch({ limit: Infinity }).limit).toBe(20);
  });
  test("uses short business keywords rather than requiring one long customer sentence", () => {
    const search = normalizeProspectSearch({ terms: ["イベント制作", "event production", "イベント制作"], companySizes: ["10-100"], roles: ["代表"] });
    expect(search.terms).toEqual(["イベント制作", "event production"]);
    expect(search.ranges).toEqual([{ min: 10, max: 100 }]);
  });
  test("SQL searches company descriptions and industry extra fields, including company-only metadata", () => {
    const predicate = prospectSearchConditions({ terms: ["製造業"], regions: ["JP"], roles: ["CEO"], companySizes: ["10-100"] });
    const query = new PgDialect().sqlToQuery(predicate!);
    expect(query.sql).toContain('"higuchi_prospect_records" "prospect_company_metadata"');
    expect(query.sql).toContain("jsonb_each_text");
    expect(query.sql).toContain('"prospect_company_metadata"."description"');
    expect(query.sql).toContain('"prospect_company_metadata"."employee_count" >=');
    expect(query.sql).toContain('"prospect_company_metadata"."employee_count" <=');
    expect(query.sql).toContain('"higuchi_prospect_records"."dataset_id"');
    expect(query.params).toContain("%製造業%"); expect(query.params).toContain("%代表取締役%");
    expect(query.params).toContain(10); expect(query.params).toContain(100);
  });
  test("SQL parameters escape wildcard metacharacters and never interpolate a keyword as SQL", () => {
    const keyword = "x%' OR true --";
    const query = new PgDialect().sqlToQuery(prospectSearchConditions({ terms: [keyword] })!);
    expect(query.sql).not.toContain(keyword); expect(query.params).toContain(prospectPattern(keyword));
    expect(prospectPattern("100%_\\")).toBe("%100\\%\\_\\\\%");
    expect(prospectSearchConditions({})).toBeUndefined();
  });
});
