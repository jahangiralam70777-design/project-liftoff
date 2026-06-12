import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { useAppStore, hasLocalAuthSession } from "@/stores/app-store";
import { supabase } from "@/integrations/supabase/client";
import { signOut } from "@/lib/auth-client";

export const Route = createFileRoute("/admin")({
  // Admin session lives in localStorage (Supabase). SSR-skip + a
  // synchronous beforeLoad gate prevents admin chrome from being
  // streamed to anonymous visitors. Server-verified role check still
  // runs inside <AdminGate /> against `user_roles`.
  ssr: false,
  beforeLoad: ({ location }) => {
    if (typeof window === "undefined") return;
    if (location.pathname === "/admin/login") return; // public sub-route
    if (!hasLocalAuthSession()) {
      throw redirect({ to: "/admin/login" });
    }
  },
  component: AdminLayout,
  head: () => ({
    meta: [
      { title: "Admin Control Center · CA Aspire BD" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content:
          "Manage students, exams, resources and platform analytics from the premium glassmorphism CA Aspire BD admin dashboard.",
      },
    ],
  }),
});

function AdminGate({ children }: { children: React.ReactNode }) {
  const user = useAppStore((s) => s.user);
  const sessionReady = useAppStore((s) => s.sessionReady);
  const authLoading = useAppStore((s) => s.authLoading);
  const refreshAuth = useAppStore((s) => s.refreshAuth);
  const navigate = useNavigate();
  const [hasSupabaseSession, setHasSupabaseSession] = useState<boolean | null>(null);
  // H-1: server-verified admin flag. Client-side role can be spoofed, so we
  // also confirm the role via a protected server fn that reads `user_roles`
  // with the user's bearer token (RLS applies).
  const [serverAdmin, setServerAdmin] = useState<boolean | null>(null);

  // Verify a real Supabase session exists.
  useEffect(() => {
    let cancelled = false;
    if (!sessionReady) return;
    (async () => {
      // getUser() revalidates with Supabase Auth (server-side check),
      // unlike getSession() which trusts the cached localStorage payload.
      // We still need the access_token for downstream queries, so fetch
      // the session AFTER the user is confirmed authentic.
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (cancelled) return;
      if (userErr || !userData.user) {
        setHasSupabaseSession(false);
        setServerAdmin(null);
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      if (cancelled) return;
      const hasToken = !!sess.session?.access_token;
      setHasSupabaseSession(hasToken);
      if (!hasToken) {
        setServerAdmin(null);
        return;
      }
      try {
        const { data: roleRow, error } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("role", "admin")
          .maybeSingle();
        if (error) throw error;
        if (!cancelled) setServerAdmin(!!roleRow);
      } catch {
        if (!cancelled) setServerAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionReady, user?.id]);

  useEffect(() => {
    if (!user && hasLocalAuthSession()) void refreshAuth({ force: true });
  }, [refreshAuth, user]);

  const status = useMemo(() => {
    if (!sessionReady || (authLoading && !user) || hasSupabaseSession === null)
      return "loading" as const;
    if (!user) {
      if (hasLocalAuthSession()) return "loading" as const;
      return "no-user" as const;
    }
    if (user.role !== "admin") return "forbidden" as const;
    if (!hasSupabaseSession && !user.id?.startsWith("demo-")) return "demo" as const;
    // Real Supabase session present → server must confirm admin role.
    if (hasSupabaseSession) {
      if (serverAdmin === null) return "loading" as const;
      if (!serverAdmin) return "forbidden" as const;
    }
    return "ok" as const;
  }, [sessionReady, authLoading, hasSupabaseSession, serverAdmin, user]);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "no-user" || status === "forbidden") {
      // Spec: any non-admin hitting /admin/* is bounced to /admin/login.
      navigate({ to: "/admin/login", replace: true });
    }
  }, [status, navigate]);

  if (status === "loading" || status === "no-user") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
        <div className="glass-card rounded-2xl px-6 py-4">Verifying admin session…</div>
      </div>
    );
  }

  if (status === "forbidden") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="glass-card max-w-md rounded-3xl p-8 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-400" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your account doesn’t have admin privileges.
          </p>
        </div>
      </div>
    );
  }

  if (status === "demo") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="glass-card max-w-md rounded-3xl p-8 text-center">
          <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-amber-400" />
          <h2 className="text-lg font-semibold">Real admin login required</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You’re signed in with a demo session, which can’t authorize backend writes. Please sign
            out and log in with a real admin account.
          </p>
          <button
            className="mt-4 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            onClick={async () => {
              await signOut().catch(() => undefined);
              navigate({ to: "/admin/login", replace: true });
            }}
          >
            Sign out & log in
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function AdminLayout() {
  const path = useLocation({ select: (l) => l.pathname });

  // The admin login page lives at /admin/login but must be publicly reachable
  // (no sidebar, no gate) so unauthenticated admins can sign in.
  if (path === "/admin/login") {
    return (
      <div className="relative min-h-dvh overflow-x-hidden bg-background text-foreground">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-hero-glow opacity-60" />
        <Outlet />
      </div>
    );
  }

  // H-4: AdminSidebar must NOT render until `verifyAdminAccess` confirms.
  // Previously it was a sibling of <AdminGate/> and therefore visible to
  // anyone hitting /admin (revealing the admin nav structure). It now
  // lives inside the gate, so non-admins see only the gate's loading /
  // forbidden / demo card.
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-hero-glow opacity-60" />
      <div className="pointer-events-none fixed left-10 top-20 -z-10 h-72 w-72 rounded-full bg-[var(--neon-purple)]/20 blur-3xl animate-pulse-glow" />
      <div className="pointer-events-none fixed right-10 bottom-10 -z-10 h-80 w-80 rounded-full bg-[var(--neon-blue)]/20 blur-3xl animate-pulse-glow" />
      <div className="pointer-events-none fixed left-1/2 top-1/3 -z-10 h-64 w-64 rounded-full bg-fuchsia-500/10 blur-3xl animate-pulse-glow" />

      <div className="mx-auto flex max-w-[1600px] gap-4 px-4 py-4 sm:px-6">
        <AdminGate>
          <AdminSidebar />
          <div className="pointer-events-auto min-w-0 flex-1 space-y-4">
            <Outlet />
          </div>
        </AdminGate>
      </div>
    </div>
  );
}
