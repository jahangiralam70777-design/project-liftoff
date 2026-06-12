import { createFileRoute } from "@tanstack/react-router";
import { DailyProgressCenter } from "@/components/dashboard/DailyProgressCenter";

export const Route = createFileRoute("/_student/daily-progress")({
  component: DailyProgressPage,
  head: () => ({
    meta: [
      { title: "Daily Progress · CA Aspire BD" },
      {
        name: "description",
        content:
          "Track daily, weekly and monthly study progress across subjects and chapters with live analytics.",
      },
    ],
  }),
});

function DailyProgressPage() {
  return <DailyProgressCenter />;
}
