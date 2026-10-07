import { MailPlus } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { cn } from "@/lib/cn";
import type { InviteListItem, InviteStatus } from "@/lib/auth/invites";
import { formatDate } from "@/lib/format";
import { revokeInviteAction } from "./actions";
import { RevokeInviteButton } from "./revoke-invite-button";

// Intentional: labels live here, not in src/lib/format.ts — invite statuses only ever appear on this admin page.
const STATUS: Record<InviteStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Pending", tone: "brand" },
  used: { label: "Used", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
};

const ANYONE = "Anyone with the link";
const th = "px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-ink-muted";
const td = "px-4 py-3 align-middle";

export function InvitesTable({ invites }: { invites: InviteListItem[] }) {
  if (invites.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<MailPlus aria-hidden />}
          title="No invites yet"
          description="Invite links you create show up here, so you can see which were used and revoke the rest."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-2xl text-sm">
          <caption className="sr-only">Invites, newest first</caption>
          <thead className="border-b border-line bg-subtle">
            <tr>
              <th scope="col" className={th}>Invitee</th>
              <th scope="col" className={th}>Status</th>
              <th scope="col" className={th}>Created</th>
              <th scope="col" className={th}>Expires</th>
              <th scope="col" className={cn(th, "text-right")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {invites.map((invite) => {
              const { label, tone } = STATUS[invite.status];
              const statusText = invite.usedByCompanyName ? `${label} by ${invite.usedByCompanyName}` : label;
              const invitee = invite.email ?? ANYONE;
              return (
                <tr key={invite.id} className="transition-colors hover:bg-subtle/60">
                  <td className={cn(td, "max-w-xs")}>
                    <p className={cn("truncate", invite.email ? "font-medium text-ink" : "text-ink-muted")} title={invitee}>
                      {invitee}
                    </p>
                  </td>
                  <td className={td}>
                    <Badge tone={tone} className="max-w-64" title={statusText}>
                      <span className="truncate">{statusText}</span>
                    </Badge>
                  </td>
                  <td className={cn(td, "whitespace-nowrap text-ink-muted")}>{formatDate(invite.createdAt)}</td>
                  <td className={cn(td, "whitespace-nowrap text-ink-muted")}>
                    {invite.status === "pending" || invite.status === "expired" ? formatDate(invite.expiresAt) : "—"}
                  </td>
                  <td className={cn(td, "text-right whitespace-nowrap")}>
                    {invite.status === "pending" && (
                      <RevokeInviteButton invitee={invitee} revokeAction={revokeInviteAction.bind(null, invite.id)} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
