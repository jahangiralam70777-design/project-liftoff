import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/app-data";
import { clearDemoSession } from "@/lib/demo-auth";
import { recordLoginEvent, recordLogoutEvent } from "@/lib/user-activity.functions";
import { checkAuthRateLimit } from "@/lib/rate-limit.functions";
import { trackEvent } from "@/lib/tracking";

const LOGIN_EVENT_KEY = "edumaster.login_event_id";

/**
 * Translate the JSON envelope produced by `checkAuthRateLimit` (server fn)
 * into a friendly UI error. The server fn throws `Error(JSON.stringify(...))`
 * when the IP exceeds the auth bucket; surface the retry hint to the caller.
 */
async function gateAuth(action: "login" | "signup" | "password_reset") {
  try {
    await checkAuthRateLimit({ data: { action } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.error === "rate_limited") {
        throw new Error(
          `Too many ${action.replace("_", " ")} attempts. Try again in ${parsed.retry_after_seconds}s.`,
        );
      }
    } catch {
      /* not a rate-limit envelope — fall through */
    }
    // Network blip or RPC error — fail open to avoid locking users out.
    console.warn("[auth] rate-limit gate skipped", e);
  }
}

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
};

// H-3: readLocalAuthSnapshot was previously used as a role fallback when
// the user_roles lookup timed out. That fallback has been removed — role
// is now derived strictly from the server response (fail-closed to
// "student"). The helper is intentionally dropped to prevent reintroduction.

export async function signInWithEmail(email: string, password: string) {
  await gateAuth("login");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  // Best-effort: track login event for analytics
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const res = await recordLoginEvent({ data: { user_agent: ua } });
    if (typeof window !== "undefined" && res?.event_id) {
      localStorage.setItem(LOGIN_EVENT_KEY, res.event_id);
    }
    try {
      trackEvent({ event_type: "login", metadata: { method: "password" } });
    } catch {
      /* swallow */
    }
  } catch (err) {
    console.warn("[auth] login event tracking failed", err);
  }
  return data;
}

export async function signUpWithEmail(input: {
  email: string;
  password: string;
  displayName?: string;
  phone?: string;
  level?: string;
  referralSource?: string;
}) {
  await gateAuth("signup");
  const redirectTo =
    typeof window !== "undefined" ? `${window.location.origin}/dashboard` : undefined;
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: redirectTo,
      data: {
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.level ? { level: input.level } : {}),
        ...(input.referralSource ? { referral_source: input.referralSource } : {}),
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function resetPasswordForEmail(email: string) {
  await gateAuth("password_reset");
  const redirectTo =
    typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function signOut() {
  clearDemoSession();
  // Best-effort: close out the login session
  try {
    if (typeof window !== "undefined") {
      const eventId = localStorage.getItem(LOGIN_EVENT_KEY);
      if (eventId) {
        await recordLogoutEvent({ data: { event_id: eventId } });
        localStorage.removeItem(LOGIN_EVENT_KEY);
      }
      try {
        trackEvent({ event_type: "logout" });
      } catch {
        /* swallow */
      }
    }
  } catch (err) {
    console.warn("[auth] logout event tracking failed", err);
  }
  const { error } = await supabase.auth.signOut();
  // 403 session_not_found just means the server already forgot the session —
  // local storage is cleared either way, so don't surface it to the UI.
  if (error && !/session.*not.*found|session_not_found|403/i.test(error.message ?? "")) {
    throw error;
  }
}

export async function fetchSessionUser(session?: Session | null): Promise<AuthUser | null> {
  const resolvedSession = session ?? (await supabase.auth.getSession()).data.session;
  if (!resolvedSession?.user) return null;

  const userId = resolvedSession.user.id;
  const email = resolvedSession.user.email ?? "";

  // Race profile/role lookups against an 8s timeout so a stalled network
  // on production never blocks the auth state from settling. If a lookup
  // times out we still return a usable AuthUser from the verified session,
  // but the role is downgraded to "student" — see H-3 below.
  const withTimeout = <T>(p: PromiseLike<T>, ms: number, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        console.warn("[auth] profile/role lookup timed out after", ms, "ms");
        resolve(fallback);
      }, ms);
      Promise.resolve(p).then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          console.warn("[auth] lookup error", e);
          resolve(fallback);
        },
      );
    });

  const [profileRes, rolesRes] = await Promise.all([
    withTimeout(
      supabase
        .from("profiles")
        .select("display_name")
        .eq("id", userId)
        .maybeSingle() as unknown as PromiseLike<{ data: { display_name?: string } | null }>,
      8000,
      { data: null } as { data: { display_name?: string } | null },
    ),
    withTimeout(
      supabase.from("user_roles").select("role").eq("user_id", userId) as unknown as PromiseLike<{
        data: { role: string }[] | null;
      }>,
      8000,
      { data: null } as { data: { role: string }[] | null },
    ),
  ]);

  const profile = profileRes.data;
  const roles = rolesRes.data;
  // H-3: NEVER fall back to a localStorage snapshot for role. A tampered
  // snapshot could otherwise grant admin UI access during a brief
  // network blip. Fail closed to "student" — admin routes still gate
  // on a fresh server-verified `verifyAdminAccess()` call (H-4), so a
  // legitimate admin sees the real role within one round trip.
  const role: AppRole =
    Array.isArray(roles) && roles.some((r) => r.role === "admin") ? "admin" : "student";

  return {
    id: userId,
    name: profile?.display_name ?? email.split("@")[0] ?? "Learner",
    email,
    role,
  };
}
