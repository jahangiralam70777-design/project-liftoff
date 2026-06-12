import { createFileRoute } from "@tanstack/react-router";
import { BlogManagerFlow } from "@/components/admin/BlogManagerFlow";

export const Route = createFileRoute("/admin/blog")({
  component: AdminBlogPage,
  head: () => ({
    meta: [
      { title: "Blog Manager · CA Aspire BD Admin" },
      {
        name: "description",
        content: "Create, edit and publish blog posts, manage categories and tags.",
      },
    ],
  }),
});

function AdminBlogPage() {
  return <BlogManagerFlow />;
}