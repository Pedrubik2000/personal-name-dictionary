// build.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import pLimit from "p-limit";
import { SaxesParser } from "saxes";
import { Dictionary, DictionaryIndex, TermEntry } from "yomichan-dict-builder";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API = "https://graphql.anilist.co";

// Official JMnedict distribution location (EDRDG) :contentReference[oaicite:1]{index=1}
const JMNEDICT_GZ_URL = "https://ftp.edrdg.org/pub/Nihongo/JMnedict.xml.gz";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripSpoilers(html) {
  if (!html) return "";
  return String(html)
    .replace(/<span[^>]*class="spoiler"[^>]*>[\s\S]*?<\/span>/gi, "[spoiler removed]")
    .replace(/\bspoiler\b/gi, "");
}

function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function isAllCjk(s) {
  return /^[\u3400-\u4DBF\u4E00-\u9FFF\u3005]+$/.test(String(s || "").trim());
}

function splitParts(s) {
  return String(s || "")
    .split(/[\s・=＝·•\u30fb]+/g)
    .map(x => x.trim())
    .filter(Boolean);
}

/**
 * Streaming JMnedict parser -> sets of kanji surnames + given names.
 * We only keep <keb> strings from entries whose <name_type> indicates surname/given/etc.
 *
 * JMnedict docs + licensing: attribution/share-alike required. :contentReference[oaicite:2]{index=2}
 */
async function loadJmnedictSets() {
  console.log("Downloading JMnedict.xml.gz…");
  const res = await fetch(JMNEDICT_GZ_URL);
  if (!res.ok) throw new Error(`JMnedict download failed: ${res.status}`);

  const gzBuf = Buffer.from(await res.arrayBuffer());
  const xmlBuf = zlib.gunzipSync(gzBuf);

  console.log("Parsing JMnedict (stream)…");
  const surnames = new Set();
  const givennames = new Set();

  const parser = new SaxesParser({ xmlns: false });

  let text = "";
  let inEntry = false;

  /** @type {string[]} */
  let kebs = [];
  /** @type {Set<string>} */
  let nameTypes = new Set();

  // Track which element text belongs to
  let currentTag = "";

  parser.on("opentag", (node) => {
    currentTag = node.name;
    if (node.name === "entry") {
      inEntry = true;
      kebs = [];
      nameTypes = new Set();
    }
    text = "";
  });

  parser.on("text", (t) => { text += t; });
  parser.on("cdata", (t) => { text += t; });

  parser.on("closetag", (tag) => {
    const val = text.trim();
    if (!inEntry) { text = ""; currentTag = ""; return; }

    if (tag === "keb" && val) {
      kebs.push(val);
    }

    if (tag === "name_type" && val) {
      // JMnedict name_type values include things like "surname", "given", etc.
      nameTypes.add(val);
    }

    if (tag === "entry") {
      // Decide if this entry is a surname/given name entry
      const isSurname = nameTypes.has("surname") || nameTypes.has("family");
      const isGiven =
        nameTypes.has("given") ||
        nameTypes.has("person") ||
        nameTypes.has("fem") ||
        nameTypes.has("masc");

      if (isSurname || isGiven) {
        for (const k of kebs) {
          if (!k || !isAllCjk(k)) continue;
          if (isSurname) surnames.add(k);
          if (isGiven) givennames.add(k);
        }
      }

      inEntry = false;
      kebs = [];
      nameTypes = new Set();
    }

    text = "";
    currentTag = "";
  });

  parser.write(xmlBuf.toString("utf8"));
  parser.close();

  console.log("JMnedict loaded:", { surnames: surnames.size, givennames: givennames.size });
  return { surnames, givennames };
}

function bestSplitWithJmnedict(nativeKanji, jm) {
  const s = String(nativeKanji || "").trim();
  if (!s || !isAllCjk(s)) return null;

  // Common name lengths; you can loosen this if needed
  const chars = [...s];
  const n = chars.length;
  if (n < 2 || n > 8) return null;

  let best = null;
  for (let cut = 1; cut <= n - 1; cut++) {
    const sur = chars.slice(0, cut).join("");
    const giv = chars.slice(cut).join("");

    if (!jm.surnames.has(sur)) continue;
    if (!jm.givennames.has(giv)) continue;

    // Prefer more typical surname lengths 2–3
    let score = 100;
    if (cut === 2) score += 15;
    if (cut === 3) score += 8;
    score += Math.min(5, sur.length) + Math.min(5, giv.length);

    if (!best || score > best.score) best = { surname: sur, given: giv, score };
  }
  return best ? { surname: best.surname, given: best.given } : null;
}

// lookup by: native, full, parts (space/・), plus variants
// + JMnedict validated splits for NO-SPACE kanji names like 綾瀬桃
function makeAliases(nameNative, nameFull, jm) {
  const aliases = new Set();
  const add = (s) => {
    if (!s) return;
    const t = String(s).trim();
    if (t) aliases.add(t);
  };

  const native = String(nameNative || "").trim();
  const full = String(nameFull || "").trim();

  // originals
  add(native);
  add(full);

  // normalizations
  if (native) {
    add(native.replace(/\s+/g, ""));
    add(native.replace(/[\s\u30fb]+/g, "")); // remove spaces + ・
  }
  if (full) add(full.toLowerCase());

  // safe splits when separators exist
  const nativeParts = splitParts(native);
  if (nativeParts.length >= 2) {
    for (const p of nativeParts) add(p); // allow 1-kanji too; you asked for near-perfect + useful
  } else if (jm && native && isAllCjk(native)) {
    // near-perfect split when no separators
    const sp = bestSplitWithJmnedict(native, jm);
    if (sp) {
      add(sp.surname);
      add(sp.given);
    }
  }

  // romaji/full parts (optional convenience)
  const fullParts = splitParts(full);
  if (fullParts.length >= 2) {
    for (const p of fullParts) {
      add(p);
      add(p.toLowerCase());
    }
  }

  return [...aliases];
}

async function gql(query, variables) {
  for (let attempt = 1; attempt <= 14; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || "0");
      const waitMs = (retryAfter ? retryAfter * 1000 : 2500) + Math.floor(Math.random() * 1200);
      console.log(`429 rate limited. Waiting ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
      continue;
    }

    const json = await res.json();
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join("\n");
      if (/too many requests|rate limit/i.test(msg)) {
        const waitMs = 2500 + Math.floor(Math.random() * 1200);
        console.log(`Rate limit error. Waiting ${Math.round(waitMs / 1000)}s…`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(msg);
    }

    return json.data;
  }
  throw new Error("Too many rate-limit retries. Reduce MAX_TITLES / CHARS_PER_TITLE and rerun.");
}

async function fetchCurrentTitles(userName, type, maxTitles) {
  const query = `
    query ($userName: String, $type: MediaType) {
      MediaListCollection(userName: $userName, type: $type) {
        lists { entries { status media { id title { romaji english native } } } }
      }
    }
  `;
  const data = await gql(query, { userName, type });

  const entries = (data?.MediaListCollection?.lists || [])
    .flatMap(l => l.entries || [])
    .filter(e => e?.status === "CURRENT");

  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const id = e?.media?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const t = e.media.title || {};
    out.push({ id, title: t.english || t.romaji || t.native || String(id) });
    if (out.length >= maxTitles) break;
  }
  return out;
}

async function fetchCharactersForMedia(mediaId, perTitle) {
  const query = `
    query ($id: Int, $perPage: Int) {
      Media(id: $id) {
        characters(page: 1, perPage: $perPage, sort: [RELEVANCE, ROLE]) {
          edges {
            node {
              id
              name { full native }
              image { large }
              description(asHtml: true)
            }
          }
        }
      }
    }
  `;
  const data = await gql(query, { id: mediaId, perPage: perTitle });
  const edges = data?.Media?.characters?.edges || [];
  return edges
    .map(ed => ({
      id: ed?.node?.id,
      nameNative: ed?.node?.name?.native || "",
      nameFull: ed?.node?.name?.full || "",
      imageUrl: ed?.node?.image?.large || "",
      descriptionHtml: ed?.node?.description || ""
    }))
    .filter(c => c.id && (c.nameNative || c.nameFull));
}

async function downloadToFile(url, filePath) {
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buf);
  return filePath;
}

function guessExtFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes(".png")) return "png";
  if (u.includes(".webp")) return "webp";
  return "jpg";
}

async function main() {
  const userName = process.env.ANILIST_USER;
  if (!userName) throw new Error("Missing ANILIST_USER");

  const MAX_TITLES = Number(process.env.MAX_TITLES || "50");
  const CHARS_PER_TITLE = Number(process.env.CHARS_PER_TITLE || "12");
  const INCLUDE_DESC = (process.env.INCLUDE_DESC || "true") === "true";

  const USE_JMNEDICT = (process.env.USE_JMNEDICT || "true") === "true";

  console.log("User:", userName);
  console.log("MAX_TITLES:", MAX_TITLES, "CHARS_PER_TITLE:", CHARS_PER_TITLE, "INCLUDE_DESC:", INCLUDE_DESC);
  console.log("USE_JMNEDICT:", USE_JMNEDICT);

  let jm = null;
  if (USE_JMNEDICT) {
    jm = await loadJmnedictSets();
  }

  console.log("Fetching CURRENT lists…");
  const [anime, manga] = await Promise.all([
    fetchCurrentTitles(userName, "ANIME", MAX_TITLES),
    fetchCurrentTitles(userName, "MANGA", MAX_TITLES),
  ]);

  const titles = [...anime, ...manga].slice(0, MAX_TITLES);
  console.log(`Titles used: ${titles.length} (anime ${anime.length}, manga ${manga.length})`);
  if (titles.length === 0) throw new Error("No CURRENT entries found.");

  const charMap = new Map(); // characterId -> data

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    console.log(`(${i + 1}/${titles.length}) ${t.title}`);
    const chars = await fetchCharactersForMedia(t.id, CHARS_PER_TITLE);

    for (const c of chars) {
      const key = String(c.id);
      if (!charMap.has(key)) {
        charMap.set(key, {
          id: key,
          nameNative: c.nameNative,
          nameFull: c.nameFull,
          imageUrl: c.imageUrl,
          descriptionHtml: INCLUDE_DESC ? stripSpoilers(c.descriptionHtml) : "",
          fromSet: new Set(),
        });
      }
      charMap.get(key).fromSet.add(t.title);
    }

    await sleep(450);
  }

  console.log("Unique characters:", charMap.size);

  const outDir = path.join(__dirname, "out");
  const tmpDir = path.join(__dirname, "tmp");
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const zipName = `anilist-characters-current-${userName}.zip`;
  const dictionary = new Dictionary({ fileName: zipName });

  // Add attribution including JMnedict if enabled (EDRDG requires attribution/share-alike) :contentReference[oaicite:3]{index=3}
  const attribution = USE_JMNEDICT
    ? "Data via AniList GraphQL API (anilist.co). Character images/descriptions from AniList sources. Name splitting aided by JMnedict (EDRDG) under the EDRDG dictionary licence (attribution + share-alike)."
    : "Data via AniList GraphQL API (anilist.co). Character images/descriptions from AniList sources. Generated for personal use.";

  const index = new DictionaryIndex()
    .setTitle(`AniList Characters (CURRENT) — ${userName}`)
    .setRevision("1")
    .setAuthor("AniList → Yomitan Generator (GitHub Actions)")
    .setDescription("Character dictionary from AniList CURRENT only. Images stored inside the dictionary. Spoilers removed. Supports name/full/partial lookup (JMnedict split for kanji names).")
    .setAttribution(attribution)
    .build();

  await dictionary.setIndex(index);

  const limitImg = pLimit(4);
  let addedImages = 0;

  for (const it of charMap.values()) {
    const from = [...it.fromSet].slice(0, 6).join(", ");
    const displayName = it.nameNative || it.nameFull || "";
    const aliases = makeAliases(it.nameNative, it.nameFull, jm);

    let zipImgPath = "";
    if (it.imageUrl) {
      const ext = guessExtFromUrl(it.imageUrl);
      const localImg = path.join(tmpDir, "img", `${it.id}.${ext}`);
      const okPath = await limitImg(() => downloadToFile(it.imageUrl, localImg));
      if (okPath) {
        zipImgPath = `img/${it.id}.${ext}`;
        await dictionary.addFile(okPath, zipImgPath);
        addedImages++;
      }
    }

    const descText = it.descriptionHtml ? htmlToText(it.descriptionHtml) : "";

    for (const term of aliases) {
      // Keep reading blank for names if you prefer; using term is also fine.
      const entry = new TermEntry(term).setReading("");

      if (zipImgPath) entry.addDetailedDefinition({ type: "image", path: zipImgPath });

      const text =
        [
          displayName,
          (it.nameNative && it.nameFull && it.nameNative !== it.nameFull) ? `Full: ${it.nameFull}` : "",
          from ? `From: ${from}` : "",
          descText ? `\n${descText}` : ""
        ].filter(Boolean).join("\n");

      entry.addDetailedDefinition({ type: "text", text });
      await dictionary.addTerm(entry.build());
    }
  }

  const stats = await dictionary.export(outDir);
  console.log("Done exporting:", path.join(outDir, zipName));
  console.log("Images added:", addedImages);
  console.table(stats);
}

main().catch(e => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
