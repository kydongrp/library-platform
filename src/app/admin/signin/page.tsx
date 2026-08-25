import { prisma } from "@/lib/db";
import { signInAsAdmin } from "@/app/actions/admin-settings";
import { evalSignInAllowed } from "@/lib/admin-session";
import { initials } from "@/lib/format";
import { SignInRowButton } from "./signin-button";

export const dynamic = "force-dynamic";

export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ limited?: string }>;
}) {
  const { limited } = await searchParams;
  // In production the switcher (and the staff directory it would disclose)
  // renders only when ALLOW_EVAL_SIGNIN=1 asks for it by name.
  if (!evalSignInAllowed()) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-14 text-center">
        <h1 className="font-display text-3xl font-semibold">Staff sign-in</h1>
        <p className="mx-auto mt-2 max-w-md text-muted-foreground">
          Sign-in is disabled on this deployment. Staff access uses the
          organisation&apos;s Microsoft Entra ID once identity integration is
          configured; the evaluation switcher requires ALLOW_EVAL_SIGNIN.
        </p>
      </div>
    );
  }

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
          Evaluation sign-in: pick a staff account to act as. Each account
          belongs to an admin group whose access matrix controls which modules
          you can see and edit. Production deployments replace this switcher
          with Microsoft Entra ID sign-in.
        </p>
      </div>

      {limited === "1" && (
        <p className="mx-auto mt-6 max-w-md rounded-md border border-border bg-muted px-4 py-3 text-center text-sm text-muted-foreground">
          Too many sign-in attempts from this address. Wait a minute and try
          again.
        </p>
      )}

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
