import { createFileRoute } from "@tanstack/react-router";
import { SiteManagementFlow } from "@/components/admin/SiteManagementFlow";

export const Route = createFileRoute("/admin/site")({
  component: SiteManagementFlow,
  head: () => ({
    meta: [
      { title: "Site Management · CA Aspire BD Admin" },
      {
        name: "description",
        content:
          "Manage CA Aspire BD website pages, homepage sections, theme settings, media, and publishing history.",
      },
    ],
  }),
});
