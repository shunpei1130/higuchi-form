import type { Metadata } from "next";
import WorkspaceShell from "@/components/higuchi/WorkspaceShell";

export const metadata: Metadata = { title: { default: "ワークスペース | higuchi-form", template: "%s | higuchi-form" }, robots: { index: false, follow: false } };
export default function Layout({ children }: { children: React.ReactNode }) { return <WorkspaceShell>{children}</WorkspaceShell>; }
