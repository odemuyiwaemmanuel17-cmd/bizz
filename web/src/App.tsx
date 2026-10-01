import { useCallback, useState, type ReactElement } from "react";
import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import ValueProposition from "./components/ValueProposition";
import HustleFeed from "./components/feed/HustleFeed";
import ValidationSection from "./components/validation/ValidationSection";
import PostBizzModal from "./components/creator/PostBizzModal";
import Footer from "./components/Footer";

export default function App(): ReactElement {
  const [postOpen, setPostOpen] = useState<boolean>(false);

  const scrollToValidate = useCallback((): void => {
    const el: HTMLElement | null = document.getElementById("validate");
    if (el !== null) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const openPostModal = useCallback((): void => setPostOpen(true), []);
  const closePostModal = useCallback((): void => setPostOpen(false), []);

  return (
    <main className="relative min-h-screen">
      <Navbar onWaitlistClick={scrollToValidate} onPostBizzClick={openPostModal} />
      <Hero onPrimaryClick={scrollToValidate} />
      <HustleFeed />
      <ValidationSection />
      <ValueProposition />
      <Footer />
      <PostBizzModal open={postOpen} onClose={closePostModal} />
    </main>
  );
}
