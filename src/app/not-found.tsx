import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { StatusPage } from "./dashboard/_components/status-page";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <StatusPage
      eyebrow="404"
      title="We couldn't find that page"
      description="It may have moved, or the link is wrong. If someone sent you a job link, ask them for a fresh one."
      actions={
        <ButtonLink href="/" size="lg">
          Go to the homepage
        </ButtonLink>
      }
    />
  );
}
