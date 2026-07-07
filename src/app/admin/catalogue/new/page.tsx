import Link from "next/link";
import { ResourceForm } from "@/components/resource-form";
import { createResource } from "@/app/actions/catalogue";

export default function NewResourcePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin/catalogue" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to catalogue
      </Link>
      <h1 className="mb-6 mt-2 font-display text-3xl font-semibold">Add a title</h1>
      <ResourceForm action={createResource} submitLabel="Create title" />
    </div>
  );
}
