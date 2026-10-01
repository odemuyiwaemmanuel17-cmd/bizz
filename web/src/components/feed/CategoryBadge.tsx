import type { ReactElement } from "react";

interface CategoryBadgeProps {
  readonly category: string;
}

const BADGE_STYLES: Readonly<Record<string, string>> = Object.freeze({
  services: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  tech: "bg-cyanGlow/10 text-cyanGlow border-cyanGlow/30",
  campus: "bg-violetGlow/10 text-violetGlow border-violetGlow/30",
  digital: "bg-indigoGlow/10 text-indigo-300 border-indigoGlow/30",
});

const FALLBACK_STYLE: string = "bg-white/5 text-slate-300 border-white/10";

/** Small pill showing the hustle's category with a per-category accent. */
export default function CategoryBadge({ category }: CategoryBadgeProps): ReactElement {
  const styleClass: string = BADGE_STYLES[category] ?? FALLBACK_STYLE;
  const label: string = category.charAt(0).toUpperCase() + category.slice(1);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${styleClass}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
