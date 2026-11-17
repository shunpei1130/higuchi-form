import Link from "next/link";
import "./higuchi-auth.css";

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return <main className="hf-auth"><div className="hf-auth-card"><Link className="hf-auth-brand" href="/"><img src="/higuchi-mark.svg" width="23" height="34" alt=""/><span>higuchi-form</span></Link><h1>{title}</h1>{subtitle&&<p className="hf-auth-subtitle">{subtitle}</p>}<div className="hf-auth-content">{children}</div>{footer&&<div className="hf-auth-caption">{footer}</div>}</div></main>;
}
