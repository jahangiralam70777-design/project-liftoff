import { createFileRoute } from "@tanstack/react-router";
import { UserManagementFlow } from "@/components/admin/UserManagementFlow";

export const Route = createFileRoute("/admin/users/")({
  component: () => <UserManagementFlow />,
});
