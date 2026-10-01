import type { ReactElement } from "react";
interface Feature {
  readonly title: string;
  readonly body: string;
  readonly icon: string;
}

const FEATURES: ReadonlyArray<Feature> = [
  {
    icon: "🚀",
    title: "Launch in seconds",
    body: "Spin up a listing with a title, price tier and one sentence. No landing pages, no code.",
  },
  {
    icon: "🧪",
    title: "Test with real people",
    body: "Share a link, collect pre-orders or waitlist signups, and watch demand signal arrive live.",
  },
  {
    icon: "🔭",
    title: "Discover what works",
    body: "Browse community-voted micro-hustles, filter by category, and copy what is already validated.",
  },
];

export default function ValueProposition(): ReactElement {
  return (
    <section id="how-it-works" className="relative mx-auto max-w-6xl px-6 py-24">
      <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
        From idea to <span className="text-gradient">validated hustle</span> — three steps
      </h2>
      <p className="mx-auto mt-4 max-w-2xl text-center text-slate-400">
        The marketplace core (listings, votes, orders) is already built. This is the front
        door that makes it feel instant.
      </p>

      <div id="discover" className="mt-14 grid gap-6 md:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <article
            key={feature.title}
            className="glass group relative overflow-hidden rounded-3xl p-8 transition hover:-translate-y-1 hover:border-white/20"
          >
            <span className="absolute right-6 top-6 text-xs font-semibold text-slate-600">
              0{index + 1}
            </span>
            <div className="text-3xl">{feature.icon}</div>
            <h3 className="mt-5 text-xl font-semibold text-white">{feature.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">{feature.body}</p>
            <div className="pointer-events-none absolute -bottom-16 -right-16 h-40 w-40 rounded-full bg-indigoGlow/10 blur-2xl transition group-hover:bg-violetGlow/20" />
          </article>
        ))}
      </div>

      <div id="validation" className="glass mt-16 flex flex-col items-center gap-6 rounded-3xl p-10 text-center sm:flex-row sm:text-left">
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-cyanGlow/30 to-indigoGlow/30 text-3xl">
          ⚡
        </div>
        <div>
          <h3 className="text-xl font-semibold">Validation votes are wired to the API</h3>
          <p className="mt-2 text-sm text-slate-400">
            <code className="rounded bg-black/40 px-1.5 py-0.5 text-cyanGlow">POST /api/votes</code>{" "}
            submits or toggles a vote per user per listing, and{" "}
            <code className="rounded bg-black/40 px-1.5 py-0.5 text-cyanGlow">GET /api/listings</code>{" "}
            powers the discovery feed with pagination and category filters.
          </p>
        </div>
      </div>
    </section>
  );
}
