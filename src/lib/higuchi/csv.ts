import { ProductError } from "./state";

/** RFC 4180-style parsing, including quoted commas/newlines and UTF-8 BOM. */
export function parseLeadCsv(input: string): Array<{ name: string; email: string; company: string; role: string; website: string }> {
  if (typeof input !== "string" || input.length > 1_000_000) throw new ProductError("CSVは1MB以内で指定してください。");
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (!field || quoted) quoted = !quoted;
      else throw new ProductError("CSVの引用符が正しくありません。");
    } else if (c === "," && !quoted) { row.push(field.trim()); field = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim()); if (row.some(Boolean)) rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (quoted) throw new ProductError("CSVの引用符が閉じられていません。");
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new ProductError("見出し行と連絡先を1件以上指定してください。");
  if (rows.length > 5001) throw new ProductError("一度に取り込める連絡先は5,000件です。");
  const header = rows[0].map((s) => s.toLowerCase().replace(/[\s_-]/g, ""));
  const column = (...names: string[]) => header.findIndex((s) => names.includes(s));
  const email = column("email", "emailaddress", "メール", "メールアドレス");
  if (email < 0) throw new ProductError("email または メールアドレス の列が必要です。");
  const name = column("name", "fullname", "氏名", "名前"), company = column("company", "companyname", "会社", "会社名"), role = column("role", "title", "jobtitle", "役職"), website = column("website", "url", "サイト");
  return rows.slice(1).map((r, i) => {
    const address = (r[email] ?? "").trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) || address.length > 254) throw new ProductError(`${i + 2}行目のメールアドレスを確認してください。`);
    return { email: address, name: (r[name] ?? "").slice(0, 200), company: (r[company] ?? "").slice(0, 300), role: (r[role] ?? "").slice(0, 200), website: (r[website] ?? "").slice(0, 2048) };
  });
}
