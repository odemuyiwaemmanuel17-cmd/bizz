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
import CreatorProfilePage from "./pages/CreatorProfilePage";
import CreatorProfileSetupPage from "./pages/CreatorProfileSetupPage";
import CreatorProfileEditPage from "./pages/CreatorProfileEditPage";
import CreatorVideoUploadPage from "./pages/CreatorVideoUploadPage";
import SavedVideosPage from "./pages/SavedVideosPage";
import ListingDetailPage from "./pages/ListingDetailPage";

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
        <Route path="/videos" element={<Navigate to="/discover?mode=videos" replace />} />
        <Route path="/saved-videos" element={<Navigate to="/dashboard/saved-videos" replace />} />
        <Route path="/listing/:listingId" element={<ListingDetailPage />} />
        <Route path="/validation" element={<ValidationPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/dashboard/profile/setup" element={<CreatorProfileSetupPage />} />
        <Route path="/dashboard/profile/edit" element={<CreatorProfileEditPage />} />
        <Route path="/dashboard/video/upload" element={<CreatorVideoUploadPage />} />
        <Route path="/dashboard/saved-videos" element={<SavedVideosPage />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/@:username" element={<CreatorProfilePage />} />
        <Route path="/feed" element={<Navigate to="/discover" replace />} />
        <Route path="/validate" element={<Navigate to="/validation" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Footer />
      <PostBizzModal open={postOpen} onClose={closePostModal} />
    </main>
  );
}
