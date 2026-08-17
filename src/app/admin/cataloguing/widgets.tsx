"use client";

import { StatefulForm, SubmitButton } from "@/components/forms";
import {
  saveTagDef, saveAuthorityType, saveAuthority,
  saveDomainCode, saveInterestTopic,
} from "@/app/actions/marc";

const f =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
const l = "mb-1 block text-xs font-medium text-muted-foreground";

function Err({ state }: { state: { ok?: boolean; message?: string } }) {
  return state.ok === false && state.message ? (
    <p className="text-sm text-red-700">{state.message}</p>
  ) : null;
}

export function TagDefForm() {
  return (
    <StatefulForm action={saveTagDef}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-[5rem_1fr_1fr] gap-2">
            <div>
              <label className={l}>Tag *</label>
              <input name="tag" required maxLength={3} placeholder="245" className={`${f} font-mono`} />
            </div>
            <div>
              <label className={l}>Display label *</label>
              <input name="label" required maxLength={120} placeholder="Title Statement" className={f} />
            </div>
            <div>
              <label className={l}>Alias</label>
              <input name="alias" maxLength={60} placeholder="Title" className={f} />
            </div>
          </div>
          <div>
            <label className={l}>Subfields — code=label, comma separated</label>
            <input name="subfieldSpec" maxLength={1000}
              placeholder="a=Title, b=Subtitle, c=Statement of responsibility" className={f} />
          </div>
          <div className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
            <div>
              <label className={l}>Description</label>
              <input name="description" maxLength={500} className={f} />
            </div>
            <div>
              <label className={l}>Sort order</label>
              <input name="sortOrder" inputMode="numeric" defaultValue={500} className={f} />
            </div>
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" name="repeatable" className="h-4 w-4 rounded border-border accent-primary" />
              Repeatable
            </label>
          </div>
          <Err state={state} />
          <div><SubmitButton pendingLabel="Saving…" variant="outline">Save tag definition</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function AuthorityTypeForm() {
  return (
    <StatefulForm action={saveAuthorityType}>
      {(state) => (
        <div className="grid grid-cols-[6rem_1fr_5rem_auto] items-end gap-2">
          <div>
            <label className={l}>Code</label>
            <input name="code" required maxLength={20} placeholder="PERS" className={f} />
          </div>
          <div>
            <label className={l}>Name</label>
            <input name="name" required maxLength={80} placeholder="Personal name" className={f} />
          </div>
          <div>
            <label className={l}>MARC tag</label>
            <input name="marcTag" maxLength={3} placeholder="100" className={`${f} font-mono`} />
          </div>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-4"><Err state={state} /></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function AuthorityForm({ types }: { types: { id: string; code: string; name: string }[] }) {
  if (types.length === 0)
    return <p className="text-sm text-muted-foreground">Add an authority type first.</p>;
  return (
    <StatefulForm action={saveAuthority}>
      {(state) => (
        <div className="grid gap-3">
          <div className="grid grid-cols-[9rem_1fr] gap-2">
            <div>
              <label className={l}>Type *</label>
              <select name="typeId" required defaultValue="" className={f}>
                <option value="" disabled>Choose…</option>
                {types.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}
              </select>
            </div>
            <div>
              <label className={l}>Heading *</label>
              <input name="heading" required maxLength={300}
                placeholder="Kleppmann, Martin" className={f} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={l}>See also / variant form</label>
              <input name="seeAlso" maxLength={300} className={f} />
            </div>
            <div>
              <label className={l}>Linked data URI</label>
              <input name="uri" type="url" maxLength={500}
                placeholder="https://id.oclc.org/worldcat/entity/…" className={f} />
            </div>
          </div>
          <Err state={state} />
          <div><SubmitButton pendingLabel="Saving…" variant="outline">Add heading</SubmitButton></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function DomainForm() {
  return (
    <StatefulForm action={saveDomainCode}>
      {(state) => (
        <div className="grid grid-cols-[7rem_1fr_auto] items-end gap-2">
          <div>
            <label className={l}>Code</label>
            <input name="code" required maxLength={20} placeholder="AERO" className={f} />
          </div>
          <div>
            <label className={l}>Name</label>
            <input name="name" required maxLength={120} placeholder="Aeronautics" className={f} />
          </div>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-3"><Err state={state} /></div>
        </div>
      )}
    </StatefulForm>
  );
}

export function TopicForm({ domains }: { domains: { id: string; code: string; name: string }[] }) {
  if (domains.length === 0)
    return <p className="text-sm text-muted-foreground">Add a domain code first.</p>;
  return (
    <StatefulForm action={saveInterestTopic}>
      {(state) => (
        <div className="grid grid-cols-[9rem_1fr_auto] items-end gap-2">
          <div>
            <label className={l}>Domain</label>
            <select name="domainId" required defaultValue="" className={f}>
              <option value="" disabled>Choose…</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.code}</option>)}
            </select>
          </div>
          <div>
            <label className={l}>Interest topic</label>
            <input name="name" required maxLength={120} placeholder="Propulsion systems" className={f} />
          </div>
          <SubmitButton pendingLabel="…" variant="outline">Add</SubmitButton>
          <div className="col-span-3"><Err state={state} /></div>
        </div>
      )}
    </StatefulForm>
  );
}
