import type { Metadata } from "next";
import { Landing } from "@/components/marketing/Landing";

export const metadata: Metadata = {
  title: "higuchi-form — あなたの代わりに、次のお客様を見つけるAI",
  description: "事業を伝えるだけ。顧客像の整理からメール、返信対応、商談のきっかけづくりまで、AIが営業を進めます。",
  robots: { index: true, follow: true },
};

export const dynamic="force-dynamic";
export default function Home() { return <Landing previewEnabled={process.env.HIGUCHI_PUBLIC_PREVIEW!=="false"}/>; }
