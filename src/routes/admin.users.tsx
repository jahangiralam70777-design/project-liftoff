import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

export const Route = createFileRoute("/admin/users")({
  component: () => <Outlet />,
  pendingComponent: AdminUsersPending,
  errorComponent: AdminUsersError,
  notFoundComponent: () => (
    <div className="p-10 text-center text-muted-foreground">User Management section not found.</div>
  ),
  head: () => ({
    meta: [
      { title: "User Management · CA Aspire BD Admin" },
      {
        name: "description",
        content:
          "Manage students, admins, permissions, subscriptions and platform activity from the CA Aspire BD identity control center.",
      },
      { property: "og:title", content: "User Management · CA Aspire BD Admin" },
      {
        property: "og:description",
        content:
          "User table, profile drawer, role permissions, bulk import and engagement analytics for administrators.",
      },
    ],
  }),
});

function AdminUsersPending() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading User Management…
    </div>
  );
}

function AdminUsersError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const message = error?.message ?? "Something went wrong loading User Management.";
  const isAuth = /forbidden|unauthor|permission/i.test(message);
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-10 text-center">
      <div className="rounded-full bg-destructive/10 p-3 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h1 className="text-xl font-semibold">User Management couldn't load</h1>
      <p className="text-sm text-muted-foreground">
        {isAuth
          ? "You don't have the required permission to view this page. Ask a super admin to grant you the manage_users capability."
          : message}
      </p>
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            reset();
            await router.invalidate();
          }}
        >
          Try again
        </Button>
        <Button variant="outline" onClick={() => router.navigate({ to: "/admin" })}>
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
