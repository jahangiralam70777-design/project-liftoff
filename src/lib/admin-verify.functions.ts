import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * H-1: Server-side admin verification.
 *
 * The /admin layout gate previously trusted only the client-side `user.role`
 * value from the local app store, which could be spoofed in browser devtools.
 * This server fn re-checks the role against the `user_roles` table using the
 * authenticated user's bearer token (RLS scoped to that user). Server-side
 * RLS on every admin write already enforced this, but the UI shell should
 * also refuse to mount for non-admins so privileged screens never render.
 */
export const verifyAdminAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isAdmin: boolean; userId: string }> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (error) {
      // Fail closed on any read error.
      return { isAdmin: false, userId };
    }
    return { isAdmin: !!data, userId };
  });
