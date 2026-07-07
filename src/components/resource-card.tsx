import Link from "next/link";
import { BookCover, Badge } from "@/components/ui";
import { RESOURCE_TYPE_LABELS } from "@/lib/constants";
import { availability } from "@/lib/availability";

type ResourceCardData = {
  id: string;
  title: string;
  author: string;
  coverColor: string;
  type: string;
  category: string;
  digital: boolean;
  provider?: string | null;
  copies: { status: string }[];
};

export function ResourceCard({ resource }: { resource: ResourceCardData }) {
  const avail = availability(resource);
  const tone =
    avail.state === "available" ? "success"
    : avail.state === "unavailable" ? "danger"
    : "primary";
  const label =
    avail.state === "external" ? (resource.provider ?? "External")
    : avail.state === "digital" ? "Instant"
    : avail.state === "available" ? "Available"
    : "Reserve";

  return (
    <Link
      href={`/portal/resource/${resource.id}`}
      className="group flex flex-col items-center text-center"
    >
      <div className="transition-transform group-hover:-translate-y-1">
        <BookCover
          title={resource.title}
          author={resource.author}
          color={resource.coverColor}
          type={resource.type}
          size="lg"
        />
      </div>
      <p className="mt-3 line-clamp-2 font-medium leading-tight">{resource.title}</p>
      <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{resource.author}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <Badge tone="muted">{RESOURCE_TYPE_LABELS[resource.type] ?? resource.type}</Badge>
        <Badge tone={tone}>{label}</Badge>
      </div>
    </Link>
  );
}
