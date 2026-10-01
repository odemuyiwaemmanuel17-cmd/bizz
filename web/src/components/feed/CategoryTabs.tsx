import type { ReactElement } from "react";
import { CATEGORY_TABS, type FeedCategory } from "../../lib/feed";

interface CategoryTabsProps {
  readonly active: FeedCategory;
  readonly onSelect: (category: FeedCategory) => void;
}

/** Horizontal filter tabs: All · Services · Tech · Campus · Digital. */
export default function CategoryTabs({ active, onSelect }: CategoryTabsProps): ReactElement {
  return (
    <div role="tablist" aria-label="Filter hustles by category" className="flex flex-wrap items-center gap-2">
      {CATEGORY_TABS.map((tab) => {
        const isActive: boolean = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/60 ${
              isActive
                ? "bg-gradient-to-r from-indigoGlow to-violetGlow text-white shadow-lg shadow-indigoGlow/25"
                : "border border-white/10 bg-white/5 text-slate-300 hover:border-white/25 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
