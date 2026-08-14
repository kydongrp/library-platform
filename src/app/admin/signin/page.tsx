import { prisma } from "@/lib/db";
import { signInAsAdmin } from "@/app/actions/admin-settings";
import { initials } from "@/lib/format";
import { SignInRowButton } from "./signin-button";

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
            <SignInRowButton
              avatar={initials(a.name)}
              name={a.name}
              email={a.email}
              group={a.group.name}
            />
          </form>
        ))}
      </div>
    </div>
  );
}
