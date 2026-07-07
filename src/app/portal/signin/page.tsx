import { prisma } from "@/lib/db";
import { signInAs } from "@/app/actions/session";
import { MEMBER_TYPE_LABELS } from "@/lib/constants";
import { initials } from "@/lib/format";

export default async function SignInPage() {
  const members = await prisma.member.findMany({
    where: { status: "ACTIVE" },
    orderBy: { name: "asc" },
  });

  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <div className="text-center">
        <h1 className="font-display text-3xl font-semibold">Choose your account</h1>
        <p className="mx-auto mt-2 max-w-lg text-muted-foreground">
          This demo skips real authentication. Pick a member to explore the portal
          as them — borrow titles, place holds, and track loans. (Full sign-in via
          Azure AD or email is a planned enhancement.)
        </p>
      </div>

      <div className="mt-10 grid gap-3 sm:grid-cols-2">
        {members.map((m) => (
          <form key={m.id} action={signInAs}>
            <input type="hidden" name="memberId" value={m.id} />
            <button
              type="submit"
              className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
                {initials(m.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">{m.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {MEMBER_TYPE_LABELS[m.memberType]} · {m.email}
                </p>
              </div>
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
