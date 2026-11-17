/** Currency amounts are always integer minor units: yen for JPY, cents for legacy USD. */
export type MoneyCurrency = "JPY" | "USD";
export type Money = { currency: MoneyCurrency; amountMinor: number; priceVersion: string };
export const JPY_PRICE_VERSION = "jpy-6-v1";
export const USD_PRICE_VERSION = "usd-4c-v1";
export const BILLING_POLICIES = {
  JPY: { currency: "JPY", priceVersion: JPY_PRICE_VERSION, emailMinor: 6, trialMinor: 4500, thresholdMinor: 750, topupMinor: [4500, 7500, 15000], scale: 1, defaultDailyMinor: 750, defaultMonthlyMinor: 15000, defaultCampaignMinor: 600 },
  USD: { currency: "USD", priceVersion: USD_PRICE_VERSION, emailMinor: 4, trialMinor: 3000, thresholdMinor: 500, topupMinor: [3000, 5000, 10000], scale: 100, defaultDailyMinor: 500, defaultMonthlyMinor: 10000, defaultCampaignMinor: 400 },
} as const;
export const billingPolicy = (currency: MoneyCurrency = "USD") => BILLING_POLICIES[currency];
export function formatMoney(amountMinor: number, currency: MoneyCurrency = "JPY"): string {
  return new Intl.NumberFormat(currency === "JPY" ? "ja-JP" : "en-US", { style: "currency", currency, minimumFractionDigits: currency === "JPY" ? 0 : 2, maximumFractionDigits: currency === "JPY" ? 0 : 2 }).format((amountMinor || 0) / billingPolicy(currency).scale);
}
export function moneyValue(amountMinor: number, currency: MoneyCurrency): Money {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("金額は最小通貨単位の整数で指定してください。");
  return { currency, amountMinor, priceVersion: billingPolicy(currency).priceVersion };
}
