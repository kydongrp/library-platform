"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import { ResourceForm } from "@/components/resource-form";
import { Card } from "@/components/ui";
import { addCopies, updateResource } from "@/app/actions/catalogue";

export function AddCopiesForm({ resourceId }: { resourceId: string }) {
  return (
    <StatefulForm action={addCopies} className="flex items-center gap-2">
      <input type="hidden" name="resourceId" value={resourceId} />
      <input
        name="count"
        type="number"
        min="1"
        max="20"
        defaultValue={1}
        aria-label="Number of copies"
        className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
      />
      <input
        name="location"
        defaultValue="Main Shelf"
        aria-label="Shelf location"
        className="w-32 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
      />
      <SubmitButton variant="outline" pendingLabel="Adding…">
        + Add copies
      </SubmitButton>
    </StatefulForm>
  );
}

type ResourceLike = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string;
  isbn: string | null;
  type: string;
  category: string;
  publisher: string | null;
  publishedYear: number | null;
  description: string | null;
  coverColor: string;
  provider: string | null;
  digitalUrl: string | null;
};

export function EditResourceSection({ resource }: { resource: ResourceLike }) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg font-semibold">Edit details</h2>
      <ResourceForm action={updateResource} defaults={resource} submitLabel="Save changes" />
    </Card>
  );
}
