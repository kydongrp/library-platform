/**
 * Common cover image selection.
 *
 *   npx tsx scripts/test-covers.ts
 *
 * Pure: no database, no network.
 *
 * The rule this guards is "collection, then publisher, then general, and never
 * a mismatched cover". The last clause is the one worth testing hardest: the
 * cheap implementation of a random fallback picks from the whole pool, which
 * puts a Defence cover on a medical report and looks deliberate to a reader.
 */
import {
  tokenFromFileName, normaliseKey, describeToken, chooseCover, sniffImageType,
  GENERAL_TOKENS, type CoverCandidate,
} from "../src/lib/cover-match";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

console.log("File name to match token, which is the whole configuration surface:");
{
  check("plain name", tokenFromFileName("defence.png") === "defence");
  check("trailing sequence number is dropped", tokenFromFileName("defence-01.png") === "defence");
  check("space before the number too", tokenFromFileName("defence 2.png") === "defence");
  check("underscores fold to spaces", tokenFromFileName("ieee_xplore_3.jpg") === "ieee xplore", tokenFromFileName("ieee_xplore_3.jpg"));
  check("case is folded", tokenFromFileName("Naval War College.png") === "naval war college");
  check("only ONE trailing group goes", tokenFromFileName("report-2024-01.png") === "report 2024", tokenFromFileName("report-2024-01.png"));
  check("a numeric name becomes general", tokenFromFileName("01.png") === "");
  check("a path is reduced to its file name", tokenFromFileName("covers/defence-1.png") === "defence");
  check("a windows path too", tokenFromFileName("C:\\covers\\defence-1.png") === "defence");
  check("webp extension", tokenFromFileName("general.webp") === "general");
  // A name with no extension must not lose its last word to the extension regex.
  check("no extension keeps the whole name", tokenFromFileName("defence") === "defence");
}

console.log("\nKey folding, so staff do not have to match punctuation exactly:");
{
  check("category folds", normaliseKey("Defence") === "defence");
  check("publisher folds", normaliseKey("IEEE Xplore") === "ieee xplore");
  check("ampersands and dots collapse", normaliseKey("Smith & Sons, Ltd.") === "smith sons ltd");
  check("null is empty, not the string null", normaliseKey(null) === "");
  check("undefined is empty", normaliseKey(undefined) === "");
  check("whitespace only is empty", normaliseKey("   ") === "");
}

console.log("\nWhat the admin screen tells staff a file will match:");
{
  const known = { collections: ["Defence", "Technology"], publishers: ["IEEE Xplore", "RAND Corporation"] };
  check("a collection name", describeToken("defence", known).scope === "collection");
  check("and names it back", describeToken("defence", known).matches === "Defence");
  check("a publisher name", describeToken("ieee xplore", known).scope === "publisher");
  // An unknown token is "unused", NOT "general". The distinction is the whole
  // point: chooseCover's general tier accepts only an empty token or a reserved
  // word, so reporting an unknown token as general would promise a fallback the
  // assignment code never delivers. The screen shows these in red instead.
  check("an unknown token is UNUSED, not a false promise of general", describeToken("mystery", known).scope === "unused");
  check("and claims no match", describeToken("mystery", known).matches === null);
  check("a reserved word IS general", describeToken("default", known).scope === "general");
  check("an explicit general token", describeToken("general", known).scope === "general");
  check("an empty token", describeToken("", known).scope === "general");
  // Collection wins if a name is somehow both, because that is the pick order.
  const both = { collections: ["Defence"], publishers: ["Defence"] };
  check("collection is reported first when a name is both", describeToken("defence", both).scope === "collection");
}

console.log("\nThe screen and the assignment code must agree about what is general:");
{
  // This guards the exact defect that shipped and was caught by the live suite:
  // describeToken called every unmatched token "general", while chooseCover's
  // general tier only accepts an empty token or a reserved word. The screen was
  // telling staff a file would be used as a fallback that could never be picked.
  const known = { collections: ["Defence"], publishers: ["IEEE Xplore"] };
  const first = () => 0;
  for (const token of ["", "general", "default", "common", "generic", "placeholder", "mystery", "defence", "ieee xplore"]) {
    const said = describeToken(token, known).scope;
    // Target nothing, so only the general tier can fire.
    const picked = chooseCover({ collection: "Nothing", publisher: "Nobody" }, [{ id: "x", token }], first);
    const pickable = picked?.matchedOn === "general";
    check(
      `"${token || "(empty)"}": says ${said}, general tier ${pickable ? "can" : "cannot"} pick it`,
      (said === "general") === pickable,
      `describeToken=${said} pickableAsGeneral=${pickable}`,
    );
  }
}

console.log("\nSelection order: collection, then publisher, then general:");
{
  const pool: CoverCandidate[] = [
    { id: "coll", token: "defence" },
    { id: "pub", token: "ieee xplore" },
    { id: "gen", token: "general" },
  ];
  const first = () => 0;

  const a = chooseCover({ collection: "Defence", publisher: "IEEE Xplore" }, pool, first);
  check("collection beats publisher", a?.id === "coll" && a?.matchedOn === "collection", JSON.stringify(a));

  const b = chooseCover({ collection: "Uncategorised", publisher: "IEEE Xplore" }, pool, first);
  check("publisher is used when the collection has no image", b?.id === "pub" && b?.matchedOn === "publisher", JSON.stringify(b));

  const c = chooseCover({ collection: "Uncategorised", publisher: "Nobody" }, pool, first);
  check("general is the last resort", c?.id === "gen" && c?.matchedOn === "general", JSON.stringify(c));

  // THE important one: no general image means no cover, never a wrong one.
  const noGeneral = pool.filter((p) => p.token !== "general");
  const d = chooseCover({ collection: "Medicine", publisher: "Elsevier" }, noGeneral, first);
  check("no match and no general image assigns NOTHING", d === null, JSON.stringify(d));

  const e = chooseCover({ collection: "Medicine", publisher: "Elsevier" }, [], first);
  check("an empty pool assigns nothing", e === null);

  // An uncategorised record must not report a collection match via the empty key.
  const f = chooseCover({ collection: "", publisher: "" }, [{ id: "x", token: "" }], first);
  check("an empty key does not masquerade as a collection match", f?.matchedOn === "general", JSON.stringify(f));

  const g = chooseCover({ collection: null, publisher: null }, pool, first);
  check("null keys fall through to general", g?.matchedOn === "general");

  // Every reserved general token must actually work as one.
  for (const t of GENERAL_TOKENS) {
    const h = chooseCover({ collection: "Nothing" }, [{ id: t, token: t }], first);
    check(`"${t}" counts as general`, h?.id === t && h?.matchedOn === "general");
  }
}

console.log("\nRandomness within a tier, and a picker that misbehaves:");
{
  const four: CoverCandidate[] = ["a", "b", "c", "d"].map((id) => ({ id, token: "defence" }));
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = chooseCover({ collection: "Defence" }, four, () => i);
    if (r) seen.add(r.id);
  }
  check("every image in a tier is reachable", seen.size === 4, [...seen].join(","));

  check("an over-range index is clamped, not thrown", chooseCover({ collection: "Defence" }, four, () => 99)?.id === "d");
  check("a negative index is clamped", chooseCover({ collection: "Defence" }, four, () => -5)?.id === "a");
  check("NaN falls back to the first", chooseCover({ collection: "Defence" }, four, () => Number.NaN)?.id === "a");
  check("a fractional index floors", chooseCover({ collection: "Defence" }, four, () => 2.7)?.id === "c");
}

console.log("\n'unused' is a strong claim, so a truncated publisher list must not make it:");
{
  const partial = { collections: ["Defence"], publishers: ["Aaa Press"], publishersTruncated: true };
  const complete = { collections: ["Defence"], publishers: ["Aaa Press"], publishersTruncated: false };
  // The same token, the same lists, differing only in whether the caller could
  // see the whole publisher set.
  check("over a COMPLETE list, an unmatched token is unused", describeToken("wiley", complete).scope === "unused");
  check("over a TRUNCATED list, it is unknown, not unused", describeToken("wiley", partial).scope === "unknown", describeToken("wiley", partial).scope);
  // Truncation must not weaken the verdicts it cannot affect.
  check("a collection still matches under truncation", describeToken("defence", partial).scope === "collection");
  check("a listed publisher still matches", describeToken("aaa press", partial).scope === "publisher");
  check("a reserved word is still general", describeToken("general", partial).scope === "general");
  // Omitting the flag entirely must behave like a complete list, so existing
  // callers keep their meaning.
  check("an absent flag reads as complete", describeToken("wiley", { collections: [], publishers: [] }).scope === "unused");
}

console.log("\nImage type read from the bytes, never from the upload's own claim:");
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  check("PNG", sniffImageType(png) === "image/png");
  check("JPEG", sniffImageType(jpg) === "image/jpeg");
  check("GIF", sniffImageType(gif) === "image/gif");
  check("WebP", sniffImageType(webp) === "image/webp");

  // SVG is XML that can carry script and would be served from this origin, so
  // it must be refused however it is labelled.
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  check("SVG is refused", sniffImageType(svg) === null);
  const html = new TextEncoder().encode("<!doctype html><html><body>hello there</body></html>");
  check("HTML is refused", sniffImageType(html) === null);
  const empty = new Uint8Array([]);
  check("empty is refused", sniffImageType(empty) === null);
  check("a truncated header is refused", sniffImageType(png.subarray(0, 6)) === null);
  // RIFF that is not WebP (a wav file) must not pass as an image.
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  check("RIFF that is not WebP is refused", sniffImageType(wav) === null);
}

console.log("\nThe import tally must never report a breakdown bigger than its total:");
{
  // Mirrors the clamp in src/lib/ingest.ts. The first version lowered `assigned`
  // alone, so a batch where the database skipped race duplicates produced
  // "1 cover assigned (2 by publisher, 1 general)": parts exceeding the whole.
  const clamp = (t: { assigned: number; collection: number; publisher: number; general: number }, imported: number) => {
    if (t.assigned > imported) {
      let excess = t.assigned - imported;
      t.assigned = imported;
      for (const tier of ["general", "publisher", "collection"] as const) {
        const take = Math.min(excess, t[tier]);
        t[tier] -= take;
        excess -= take;
        if (excess === 0) break;
      }
    }
    return t;
  };
  const a = clamp({ assigned: 3, collection: 1, publisher: 1, general: 1 }, 1);
  check("total comes down to what was inserted", a.assigned === 1, JSON.stringify(a));
  check("and the tiers sum to it", a.collection + a.publisher + a.general === a.assigned, JSON.stringify(a));
  check("the least specific tier is dropped first", a.general === 0 && a.collection === 1, JSON.stringify(a));

  const b = clamp({ assigned: 5, collection: 2, publisher: 3, general: 0 }, 0);
  check("clamping to zero empties every tier", b.assigned === 0 && b.collection === 0 && b.publisher === 0, JSON.stringify(b));

  const c = clamp({ assigned: 2, collection: 1, publisher: 1, general: 0 }, 9);
  check("no clamp when nothing was skipped", c.assigned === 2 && c.collection === 1 && c.publisher === 1, JSON.stringify(c));
}

console.log(
  failures === 0
    ? "\nCLEAN: the order holds, an unmatched record with no general image gets no cover rather than a wrong one, and only real image bytes are accepted."
    : `\nFAILED: ${failures} assertion(s).`,
);
process.exit(failures === 0 ? 0 : 1);
