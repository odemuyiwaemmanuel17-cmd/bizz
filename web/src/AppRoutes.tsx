/** Router shell: Navbar + routes + Footer + global Post-a-Bizz modal. */
import { useCallback, useState, type ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import PostBizzModal from "./components/creator/PostBizzModal";
import LandingPage from "./pages/LandingPage";
import DiscoverPage from "./pages/DiscoverPage";
import ValidationPage from "./pages/ValidationPage";
import DashboardPage from "./pages/DashboardPage";
import AuthPage from "./pages/AuthPage";

export default function AppRoutes(): ReactElement {
  const [postOpen, setPostOpen] = useState<boolean>(false);
  const openPostModal = useCallback((): void => setPostOpen(true), []);
  const closePostModal = useCallback((): void => setPostOpen(false), []);

  return (
    <main className="relative min-h-screen">
      <Navbar onPostBizzClick={openPostModal} />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/validation" element={<ValidationPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/feed" element={<Navigate to="/discover" replace />} />
        <Route path="/validate" element={<Navigate to="/validation" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
      <PostBizzModal open={postOpen} onClose={closePostModal} />
    </main>
  );
}
