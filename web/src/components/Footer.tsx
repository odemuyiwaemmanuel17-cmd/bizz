import type { ReactElement } from "react";

export default function Footer(): ReactElement {
  return (
    <footer className="border-t border-white/5 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-slate-500 sm:flex-row">
        <p>© {new Date().getFullYear()} HustleHub — launch, test, and discover micro-hustles.</p>
        <div className="flex gap-6">
          <a href="#top" className="transition hover:text-slate-300">Back to top ↑</a>
          <a href="#how-it-works" className="transition hover:text-slate-300">How it works</a>
        </div>
      </div>
    </footer>
  );
}
