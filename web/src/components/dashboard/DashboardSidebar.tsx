import { useState, type ReactElement } from "react";
import { Link, useLocation } from "react-router-dom";

interface SidebarItem {
  readonly label: string;
  readonly to: string;
  readonly icon: string;
  readonly exact?: boolean;
}

interface SidebarGroup {
  readonly label: string;
  readonly items: readonly SidebarItem[];
}

const GROUPS: readonly SidebarGroup[] = [
  {
    label: "Workspace",
    items: [{ label: "Overview", to: "/dashboard", icon: "⌂", exact: true }],
  },
  {
    label: "Content",
    items: [
      { label: "My Bizzes", to: "/discover?mode=bizzes", icon: "✦" },
      { label: "My Videos", to: "/dashboard/videos", icon: "▶" },
      { label: "Saved Videos", to: "/dashboard/saved-videos", icon: "▱" },
    ],
  },
  {
    label: "Creator",
    items: [
      { label: "My Profile", to: "/dashboard/profile/edit", icon: "◉" },
      { label: "Analytics", to: "/dashboard/analytics", icon: "↗" },
      { label: "Promotions", to: "/dashboard/promotions", icon: "◇" },
      { label: "Monetization", to: "/dashboard/monetization", icon: "$" },
    ],
  },
  {
    label: "Trust",
    items: [{ label: "Verification", to: "/dashboard/verification", icon: "✓" }],
  },
];

function isItemActive(pathname: string, item: SidebarItem): boolean {
  return item.exact === true ? pathname === item.to : pathname.startsWith(item.to.split("?")[0] ?? item.to);
}

function ItemLink({ item, pathname, onNavigate }: { readonly item: SidebarItem; readonly pathname: string; readonly onNavigate: () => void }): ReactElement {
  const active = isItemActive(pathname, item);
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${active ? "bg-gradient-to-r from-indigoGlow/25 to-violetGlow/25 font-semibold text-white ring-1 ring-violetGlow/30" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
    >
      <span aria-hidden="true" className={`grid h-6 w-6 place-items-center rounded-lg text-xs ${active ? "bg-violetGlow/30 text-cyan-200" : "bg-white/5 text-slate-500"}`}>{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}

export default function DashboardSidebar(): ReactElement {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  function closeMobile(): void {
    setMobileOpen(false);
  }

  return (
    <aside className="min-w-0 md:sticky md:top-28 md:self-start">
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        aria-expanded={mobileOpen}
        className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm font-semibold text-white md:hidden"
      >
        <span className="flex items-center gap-2"><span className="text-cyan-200">☰</span> Dashboard navigation</span>
        <span aria-hidden="true" className="text-slate-400">{mobileOpen ? "−" : "+"}</span>
      </button>
      <nav aria-label="Dashboard sections" className={`${mobileOpen ? "mt-3 block" : "hidden"} rounded-2xl border border-white/10 bg-slate-950/70 p-3 md:mt-0 md:block md:border-0 md:bg-transparent md:p-0`}>
        {GROUPS.map((group) => (
          <section key={group.label} className="mb-5 last:mb-0">
            <h2 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">{group.label}</h2>
            <div className="space-y-1">
              {group.items.map((item) => <ItemLink key={item.to} item={item} pathname={location.pathname} onNavigate={closeMobile} />)}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}
