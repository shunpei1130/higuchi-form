import type { Metadata } from "next";
import { PreviewExplore } from "@/components/preview/PreviewExplore";

export const metadata: Metadata = { title: "営業の準備 | higuchi-form", robots: { index: false, follow: false } };
export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run } = await searchParams;
  return <PreviewExplore key={run || "empty"} runId={run || ""} />;
}
