// build.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import pLimit from "p-limit";
import { Dictionary, DictionaryIndex, TermEntry } from "yomichan-dict-builder";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API = "https://graphql.anilist.co";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripSpoilers(html) {
  if (!html) return "";
  return String(html)
    .replace(/<span[^>]*class="spoiler"[^>]*>[\s\S]*?<\/span>/gi, "[spoiler removed]")
    .replace(/\bspoiler\b/gi, "");
}

// Aliases so lookup works for full + partial (native and romaji)
function makeAliases(nameNative, nameFull) {
  const aliases = new Set();
  const add = (s) => { if (s && String(s).trim()) aliases.add(String(s).trim()); };

  add(nameNative);
  add(nameFull);

  const splitParts = (s) =>
    String(s || "")
      .split(/[\s・=＝·•\u30fb]+/g)
      .map(x => x.trim())
      .filter(Boolean);

  for (const p of splitParts(nameNative)) if (p.length >= 2) add(p);
  for (const p of splitParts(nameFull)) if (p.length >= 2) add(p);

  if (nameNative) add(String(nameNative).replace(/\s+/g, ""));
  if (nameFull) add(String(nameFull).toLowerCase());

  return [...aliases];
}

// Convert an image URL to an embedded data URL (base64)
// This avoids dictionary.addFile() API differences across library versions.
async function imageUrlToDataUrl(url) {
  if (!url) return "";
  const res = await fetch(url);
  if (!res.ok) return "";
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const b64 = buf.toString("base64");
  return `data:${contentType};base64,${b64}`;
}

// GraphQL with rate-limit backoff
async function gql(query, variables) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") || "0");
      const waitMs = (retryAfter ? retryAfter * 1000 : 2500) + Math.floor(Math.random() * 1200);
      console.log(`429 rate limited. Waiting ${Math.round(waitMs/1000)}s…`);
      await sleep(waitMs);
      continue;
    }

    const json = await res.json();
    if (json.errors) {
      const msg = json.errors.map(e => e.message).join("\n");
      if (/too many requests|rate limit/i.test(msg)) {
        const waitMs = 2500 + Math.floor(Math.random() * 1200);
        console.log(`Rate limit error. Waiting ${Math.round(waitMs/1000)}s…`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(msg);
    }
    return json.data;
  }
  throw new Error("Too many rate-limit retries. Reduce limits or rerun later.");
}

// CURRENT only list
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

// Try TermEntry methods across versions
function buildTermEntry(term, html) {
  const te = new TermEntry(term);

  // Prefer the most detailed method if present; fall back gracefully
  if (typeof te.addDetailedDefinition === "function") {
    return te.addDetailedDefinition(html).build();
  }
  if (typeof te.addDefinition === "function") {
    return te.addDefinition(html).build();
  }
  if (typeof te.addGlossary === "function") {
    return te.addGlossary(html).build();
  }

  // Last resort: some versions accept constructor options; throw if unknown
  throw new Error("Unsupported yomichan-dict-builder version: no known TermEntry definition method.");
}

async function main() {
  const userName = process.env.ANILIST_USER;
  if (!userName) throw new Error("Missing ANILIST_USER env var");

  const MAX_TITLES = Number(process.env.MAX_TITLES || "50");
  const CHARS_PER_TITLE = Number(process.env.CHARS_PER_TITLE || "12");
  const INCLUDE_DESC = (process.env.INCLUDE_DESC || "true") === "true";

  console.log("User:", userName);
  console.log("MAX_TITLES:", MAX_TITLES, "CHARS_PER_TITLE:", CHARS_PER_TITLE, "INCLUDE_DESC:", INCLUDE_DESC);

  console.log("Fetching CURRENT lists…");
  const [anime, manga] = await Promise.all([
    fetchCurrentTitles(userName, "ANIME", MAX_TITLES),
    fetchCurrentTitles(userName, "MANGA", MAX_TITLES),
  ]);

  const titles = [...anime, ...manga].slice(0, MAX_TITLES);
  console.log(`Titles used: ${titles.length} (anime ${anime.length}, manga ${manga.length})`);
  if (titles.length === 0) throw new Error("No CURRENT entries found.");

  const charMap = new Map(); // characterId -> {.., fromSet}

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    console.log(`(${i+1}/${titles.length}) ${t.title}`);
    const chars = await fetchCharactersForMedia(t.id, CHARS_PER_TITLE);

    for (const c of chars) {
      const key = String(c.id);
      if (!charMap.has(key)) {
        charMap.set(key, {
          nameNative: c.nameNative,
          nameFull: c.nameFull,
          imageUrl: c.imageUrl,
          descriptionHtml: INCLUDE_DESC ? stripSpoilers(c.descriptionHtml) : "",
          fromSet: new Set(),
        });
      }
      charMap.get(key).fromSet.add(t.title);
    }

    // pacing to reduce 429 risk
    await sleep(450);
  }

  console.log("Unique characters:", charMap.size);

  const outDir = path.join(__dirname, "out");
  await fs.mkdir(outDir, { recursive: true });

  const zipName = `anilist-characters-current-${userName}.zip`;
  const dictionary = new Dictionary({ fileName: zipName });

  const index = new DictionaryIndex()
    .setTitle(`AniList Characters (CURRENT) — ${userName}`)
    .setRevision("1")
    .setAuthor("AniList → Yomitan Generator (GitHub Actions)")
    .setDescription("Character dictionary from AniList CURRENT only. Images embedded as data URLs. Spoilers removed. Supports full + partial name lookup.")
    .setAttribution("Data via AniList GraphQL API (anilist.co). Images/descriptions from AniList content sources. Generated for personal use.")
    .build();

  await dictionary.setIndex(index);

  // Limit parallel image downloads to avoid spikes
  const limit = pLimit(4);

  const entries = [...charMap.values()];
  console.log(`Building terms for ${entries.length} characters…`);

  for (let i = 0; i < entries.length; i++) {
    const it = entries[i];
    const from = [...it.fromSet].slice(0, 6).join(", ");

    let imgDataUrl = "";
    try {
      imgDataUrl = await limit(() => imageUrlToDataUrl(it.imageUrl));
    } catch {
      imgDataUrl = "";
    }

    const displayName = it.nameNative || it.nameFull || "";
    const html =
      `<div>` +
      (imgDataUrl ? `<div><img src="${imgDataUrl}" style="max-width:220px;height:auto;border-radius:10px;"></div>` : ``) +
      `<div style="margin-top:6px;"><b>${displayName}</b></div>` +
      (it.nameNative && it.nameFull && it.nameNative !== it.nameFull ? `<div>(${it.nameFull})</div>` : ``) +
      (from ? `<div><i>From:</i> ${from}</div>` : ``) +
      (it.descriptionHtml ? `<div style="margin-top:6px;">${it.descriptionHtml}</div>` : ``) +
      `</div>`;

    const terms = makeAliases(it.nameNative, it.nameFull);

    for (const term of terms) {
      const teBuilt = buildTermEntry(term, html);
      await dictionary.addTerm(teBuilt);
    }
  }

  await dictionary.export(outDir);
  console.log("Wrote:", path.join(outDir, zipName));
}

main().catch(e => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});
