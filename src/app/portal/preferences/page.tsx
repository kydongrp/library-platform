import { getCurrentMember } from "@/lib/session";
import { EmptyState, ButtonLink, Card } from "@/components/ui";
import { InterestsForm } from "./form";
import { CATEGORIES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const member = await getCurrentMember();
  if (!member) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-14">
        <EmptyState
          title="Sign in to set your preferences"
          description="Pick your areas of interest to personalise recommendations."
          action={<ButtonLink href="/portal/signin">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-display text-3xl font-semibold">Preference Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Pick the areas you care about — your homepage recommendations follow them.
      </p>

      <Card className="mt-6 p-5">
        <InterestsForm all={[...CATEGORIES]} selected={member.interests} />
      </Card>
    </div>
  );
}
