/** `/validation` — the dedicated “Bizz or Fizz” idea-testing arena. */
import type { ReactElement } from "react";
import ValidationSection from "../components/validation/ValidationSection";

export default function ValidationPage(): ReactElement {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-28 sm:px-6">
      <header className="mb-6">
        <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
          Bizz or Fizz arena
        </h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 sm:text-base">
          Vote on early-stage concepts before anyone spends a dime building them.
          Real-time tallies decide what gets validated.
        </p>
      </header>
      <ValidationSection />
    </div>
  );
}
