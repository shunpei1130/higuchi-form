import type { Metadata } from "next";
import "./booking.css";
export const metadata: Metadata = { title: "商談の予約 | higuchi-form", robots: { index: false, follow: false } };
export default function BookingLayout({ children }: { children: React.ReactNode }) { return <main className="hf-booking">{children}</main>; }
