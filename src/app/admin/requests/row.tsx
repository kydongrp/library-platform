"use client";

import { Badge } from "@/components/ui";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { updateRequestStatus } from "@/app/actions/requests";

const STATUS_TONE: Record<string, "muted" | "success" | "danger" | "primary"> = {
  PENDING: "muted",
  APPROVED: "success",
  REJECTED: "danger",
  ACQUIRED: "primary",
};

type RequestData = {
  id: string;
  title: string;
  author: string | null;
  details: string | null;
  status: string;
  staffNote: string | null;
  memberName: string;
  createdAt: string;
};

export function RequestRow({ request, readOnly }: { request: RequestData; readOnly: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{request.title}</p>
          <p className="text-sm text-muted-foreground">
            {request.author ? `${request.author} · ` : ""}
            requested by {request.memberName} · {request.createdAt}
          </p>
          {request.details && (
            <p className="mt-1 text-xs text-muted-foreground">“{request.details}”</p>
          )}
        </div>
        <Badge tone={STATUS_TONE[request.status] ?? "muted"}>{request.status.toLowerCase()}</Badge>
      </div>

      {!readOnly && (
        <StatefulForm action={updateRequestStatus} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="requestId" value={request.id} />
          <select
            name="status"
            defaultValue={request.status}
            aria-label="Request status"
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs"
          >
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved (to acquire)</option>
            <option value="ACQUIRED">Acquired (in catalogue)</option>
            <option value="REJECTED">Rejected</option>
          </select>
          <input
            name="staffNote"
            defaultValue={request.staffNote ?? ""}
            placeholder="Note to requester (optional)"
            className="min-w-52 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs"
          />
          <SubmitButton variant="outline" className="!px-3 !py-1.5 text-xs" pendingLabel="…">
            Update
          </SubmitButton>
        </StatefulForm>
      )}
    </div>
  );
}
