import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentMember } from "@/lib/session";
import { Card, EmptyState, ButtonLink, BookCover, Badge } from "@/components/ui";
import { NewFolderForm, RemoveBookmarkButton, DeleteFolderButton } from "./widgets";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function FavouritesPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to see your favourites"
          description="Save titles into named collections and find them again fast."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const folders = await prisma.favouriteFolder.findMany({
    where: { memberId: member.id },
    include: {
      items: {
        include: { resource: true },
        orderBy: { addedAt: "desc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const total = folders.reduce((n, f) => n + f.items.length, 0);

  return (
    <div className="mx-auto max-w-4xl px-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold">My Favourites</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total} title{total === 1 ? "" : "s"} across {folders.length} collection{folders.length === 1 ? "" : "s"}
          </p>
        </div>
        <NewFolderForm />
      </div>

      {folders.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="No collections yet"
            description="Save any title with the ♡ button on its page — it lands in “My Favourites” by default, or create your own collections."
            action={<ButtonLink href="/portal">Browse the collection</ButtonLink>}
          />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {folders.map((folder) => (
            <Card key={folder.id} className="p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-lg font-semibold">{folder.name}</h2>
                  <Badge tone="muted">{folder.items.length}</Badge>
                </div>
                <DeleteFolderButton folderId={folder.id} name={folder.name} />
              </div>
              {folder.items.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">Empty — add titles from any resource page.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {folder.items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 py-2.5">
                      <Link href={`/portal/resource/${item.resourceId}`}>
                        <BookCover title={item.resource.title} author={item.resource.author} color={item.resource.coverColor} size="sm" />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <Link href={`/portal/resource/${item.resourceId}`} className="truncate font-medium hover:underline">
                          {item.resource.title}
                        </Link>
                        <p className="truncate text-sm text-muted-foreground">
                          {item.resource.author} · saved {formatDate(item.addedAt)}
                        </p>
                      </div>
                      <RemoveBookmarkButton folderId={folder.id} resourceId={item.resourceId} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
