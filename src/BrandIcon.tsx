import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg?url";
import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg?url";
import type { CSSProperties } from "react";

export type BrandIconName = "codex" | "claude";

export default function BrandIcon({ brand, size = 14 }: { brand: BrandIconName; size?: number }) {
  if (brand === "codex") {
    return <span className="brand-icon brand-icon-openai" aria-hidden="true" style={{ "--brand-icon-url": `url("${openAiIcon}")`, width: size, height: size } as CSSProperties} />;
  }
  return <span className="brand-icon" aria-hidden="true" style={{ width: size, height: size }}><img src={claudeIcon} alt="" /></span>;
}
