import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  getSessionSafe,
  signInWithGoogle,
  signInWithMagicLink,
  signInWithPassword,
  signOut as sbSignOut,
  signUpWithEmail,
  subscribeToAuth,
  type AuthResult,
  type AuthSnapshot,
  type AuthStatus,
} from "../lib/supabase";

export interface UseAuthResult {
  readonly status: AuthStatus;
  readonly user: User | null;
  readonly isAuthenticated: boolean;
  readonly signIn: (email: string) => Promise<AuthResult>;
  readonly signInPassword: (email: string, password: string) => Promise<AuthResult>;
  readonly signUp: (email: string, password: string) => Promise<AuthResult>;
  readonly signInGoogle: () => Promise<AuthResult>;
  readonly signOut: () => Promise<void>;
}

const INITIAL: AuthSnapshot = { status: "unauthenticated", user: null, session: null };

/** React hook exposing Supabase auth state with graceful offline fallback. */
export function useAuth(): UseAuthResult {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void getSessionSafe().then((initial: AuthSnapshot) => {
      if (!cancelled) setSnapshot(initial);
    });
    const unsubscribe: () => void = subscribeToAuth((next: AuthSnapshot) => {
      if (!cancelled) setSnapshot(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(
    (email: string) => signInWithMagicLink(email),
    [],
  );

  const signInPassword = useCallback(
    (email: string, password: string) => signInWithPassword(email, password),
    [],
  );

  const signUp = useCallback(
    (email: string, password: string) => signUpWithEmail(email, password),
    [],
  );

  const signInGoogle = useCallback(() => signInWithGoogle(), []);

  const signOut = useCallback(async (): Promise<void> => {
    const next: AuthSnapshot = await sbSignOut();
    setSnapshot(next);
  }, []);

  return {
    status: snapshot.status,
    user: snapshot.user,
    isAuthenticated: snapshot.status === "authenticated" && snapshot.user !== null,
    signIn,
    signInPassword,
    signUp,
    signInGoogle,
    signOut,
  };
}
