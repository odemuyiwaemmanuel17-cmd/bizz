# Phase 2 — Project Setup & 3D Landing Page

The web app lives in [`web/`](./web): **Vite + React + TypeScript + Tailwind CSS** with an interactive **React Three Fiber** hero.

## Quick start

```bash
cd web
npm install
cp .env.example .env.local   # fill in your Supabase project URL + anon key
npm run dev                  # http://localhost:5173
```

- `npm run build` type-checks (`tsc --noEmit`) and produces an optimised bundle.
- Auth degrades gracefully when env vars are missing (offline mode) — the landing page still renders.

## What is in place

| Requirement | Where |
|---|---|
| Vite + React + TS boilerplate | `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json` |
| Tailwind CSS | `web/tailwind.config.js`, `web/postcss.config.js`, `web/src/index.css` |
| Supabase client + env config | `web/src/lib/env.ts`, `web/src/lib/supabase.ts`, `web/src/hooks/useAuth.ts`, `web/.env.example` |
| Interactive 3D hero (R3F + drei) | `web/src/components/webgl/HeroBadge.tsx` — floating glass coin + extruded monogram, follows the mouse, click toggles spin |
| Landing layout + value prop | `web/src/App.tsx`, `web/src/components/Hero.tsx`, `ValueProposition.tsx`, `Navbar.tsx`, `Footer.tsx` |
| DB schema for listings/votes | `supabase/schema.sql` (RLS policies included) |

## Notes

- The 3D canvas is lazy-loaded (`React.lazy`) so first paint stays fast; a glow skeleton shows while it loads.
- Sign-in uses Supabase magic links; sign-out clears the session. See `useAuth()`.
- Next phase: wire `GET /api/listings`, `POST /api/listings`, `POST /api/votes` to this UI.
