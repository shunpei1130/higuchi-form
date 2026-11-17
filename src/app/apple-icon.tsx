import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
export const runtime="nodejs";
export const size={width:180,height:180};
export const contentType="image/png";
export default async function AppleIcon() {
  const mark=await readFile(path.join(process.cwd(),"public","higuchi-mark.svg"));
  return new ImageResponse(<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"#f6f5f3"}}><img alt="" src={`data:image/svg+xml;base64,${mark.toString("base64")}`} width={90} height={140}/></div>,size);
}
