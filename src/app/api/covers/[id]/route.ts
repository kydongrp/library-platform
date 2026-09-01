import { prisma } from "@/lib/db";
import { getCurrentAdmin, canView } from "@/lib/admin-session";

/**
 * GET /api/covers/<id>: the bytes of one common cover image.
 *
 * Cover images live in the database (see prisma/schema.prisma CoverImage) so
 * they inherit this platform's Singapore residency position and need no second
 * service or credential. That means they need a route to be seen through, and
 * this is it.
 *
 * AUTHENTICATED, unlike the public acquisitions feed, and the reasoning is the
 * opposite way round. The feed had to be open because a feed reader has nowhere
 * to put a key. Nothing needs these images except the admin console, so there
 * is no reason to publish them, and an unauthenticated binary endpoint over a
 * database table is a thing to justify rather than assume. CATALOGUE view is
 * the gate, matching every other page these images appear on.
 *
 * If the learner portal is later to show these covers, that is a deliberate
 * decision to make then: serve them through the Portal API's keyed surface, or
 * open this route knowingly. Do not widen it by accident.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await getCurrentAdmin();
  if (!canView(admin, "CATALOGUE")) {
    // 404 rather than 403: an unauthorised caller learns nothing about whether
    // the id exists.
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const { id } = await ctx.params;
  const image = await prisma.coverImage.findUnique({
    where: { id },
    select: { bytes: true, mimeType: true, sizeBytes: true },
  });
  if (!image) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  // Prisma returns Bytes as a Uint8Array. Copy into a fresh ArrayBuffer so the
  // Response body is a plain buffer regardless of how the driver allocated it.
  const body = new Uint8Array(image.bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": image.mimeType,
      "Content-Length": String(image.sizeBytes),
      // The bytes at an id never change: an edit is a new upload with a new id.
      // So this is immutable, but PRIVATE: a shared cache must not hold an
      // authenticated response where another reader could pick it up.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Belt and braces on a route that returns bytes from a database.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
}
