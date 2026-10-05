/** `/` — clean high-impact intro: 3D hero, value proposition, nav links. */
import type { ReactElement } from "react";
import Hero from "../components/Hero";
import ValueProposition from "../components/ValueProposition";

export default function LandingPage(): ReactElement {
  return (
    <div className="pt-24">
      <Hero />
      <ValueProposition />
    </div>
  );
}
