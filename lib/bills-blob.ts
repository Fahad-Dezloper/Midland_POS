import { del, get, list, put } from "@vercel/blob";

/**
 * Vercel Blob backend for the bills store, used automatically when
 * `BLOB_READ_WRITE_TOKEN` is present. Stores the same single JSON document as
 * the local filesystem backend, so the rest of the app is unchanged.
 *
 * Access mode (set `BLOB_ACCESS`):
 *  - "public" (default) — works on a standard (public) Blob store. Each write
 *    creates a NEW blob with a random, unguessable suffix; reads take the newest
 *    version and old versions are deleted. Because the URL is random and never
 *    reused, the data is not reachable by guessing a path.
 *  - "private" — for a Blob store configured with private access. Uses a fixed
 *    path and authenticated reads, so the data is never fetchable without the
 *    store token at all.
 *
 * Either way, reads distinguish "not found" (→ empty store) from real errors
 * (→ thrown), so a transient failure can never overwrite good data with nothing.
 */

const ACCESS: "public" | "private" =
  process.env.BLOB_ACCESS === "private" ? "private" : "public";

const BASE = "midland/bills";
const PRIVATE_PATH = `${BASE}.json`;
const isCorrupt = (pathname: string) => pathname.includes("corrupt");

async function readPublic(): Promise<string | null> {
  const { blobs } = await list({ prefix: BASE });
  const versions = blobs
    .filter((b) => !isCorrupt(b.pathname))
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  if (versions.length === 0) return null;

  const res = await fetch(versions[0].url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
  return res.text();
}

async function readPrivate(): Promise<string | null> {
  const result = await get(PRIVATE_PATH, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return new Response(result.stream).text();
}

async function writePublic(content: string): Promise<void> {
  const created = await put(`${BASE}.json`, content, {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/json",
  });
  // Delete previous versions so only the newest document remains (best effort).
  try {
    const { blobs } = await list({ prefix: BASE });
    const stale = blobs.filter(
      (b) => b.url !== created.url && !isCorrupt(b.pathname),
    );
    if (stale.length > 0) await del(stale.map((b) => b.url));
  } catch {
    // Leaving an old version behind is harmless — reads always take the newest.
  }
}

async function writePrivate(content: string): Promise<void> {
  await put(PRIVATE_PATH, content, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export function createBlobDriver() {
  return {
    readJson(): Promise<string | null> {
      return ACCESS === "private" ? readPrivate() : readPublic();
    },
    writeJson(content: string): Promise<void> {
      return ACCESS === "private" ? writePrivate(content) : writePublic(content);
    },
    async writeCsv(): Promise<void> {
      // No-op on Blob: the export endpoint rebuilds the CSV from the store on
      // demand, so there is no need to persist a second copy.
    },
    async backupCorrupt(content: string): Promise<void> {
      try {
        await put(`${BASE}.corrupt-${Date.now()}.json`, content, {
          access: ACCESS,
          addRandomSuffix: true,
          contentType: "application/json",
        });
      } catch {
        // Best effort — never let a backup failure break the request.
      }
    },
  };
}
