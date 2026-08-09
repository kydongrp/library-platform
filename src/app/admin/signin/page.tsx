import { prisma } from "@/lib/db";
import { signInAsAdmin } from "@/app/actions/admin-settings";
import { initials } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminSignInPage() {
  const admins = await prisma.adminUser.findMany({
    where: { status: "ACTIVE" },
    include: { group: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-2xl px-5 py-14">
      <div className="text-center">
        <h1 className="font-display text-3xl font-semibold">Staff sign-in</h1>
        <p className="mx-auto mt-2 max-w-md text-muted-foreground">
          Pick a staff account to act as. Each account belongs to an admin group
          whose access matrix controls which modules you can see and edit.
          (Azure AD sign-in is stubbed in this prototype.)
        </p>
      </div>

      <div className="mt-10 grid gap-3">
        {admins.map((a) => (
          <form key={a.id} action={signInAsAdmin}>
            <input type="hidden" name="adminId" value={a.id} />
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {initials(a.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{a.name}</p>
                <p className="truncate text-sm text-muted-foreground">{a.email}</p>
              </div>
              <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-stone-600">
                {a.group.name}
              </span>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
