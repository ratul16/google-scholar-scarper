/**
 * Google Scholar Stats Scraper
 * Cloudflare Worker with KV storage and Cron scheduling
 */

const KV_KEY = "scholar_stats";

// ── Scraper ────────────────────────────────────────────────────────────────

async function scrapeScholarStats(scholarUrl) {
  const url = new URL(scholarUrl);
  url.searchParams.set("pagesize", "100");

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Scholar page: HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseScholarHTML(html, scholarUrl);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, "").trim();
}

function parseScholarHTML(html, profileUrl) {
  const result = {
    name: null,
    affiliation: null,
    homepage: null,
    interests: [],
    avatarUrl: null,
    citations: { all: null, recent: null },
    hIndex: { all: null, recent: null },
    i10Index: { all: null, recent: null },
    publications: [],
    citationHistory: [],
    scrapedAt: new Date().toISOString(),
    profileUrl,
  };

  // Name
  const nameMatch = html.match(/id="gsc_prf_in"[^>]*>([^<]+)<\/div>/);
  if (nameMatch) result.name = decodeHtmlEntities(nameMatch[1].trim());

  // Affiliation
  const affMatch = html.match(/class="gsc_prf_ila"[^>]*>([^<]+)<\/a>/);
  if (affMatch) result.affiliation = decodeHtmlEntities(affMatch[1].trim());

  // Homepage — inside id="gsc_prf_ivh", href comes before rel="nofollow"
  const homepageMatch = html.match(/id="gsc_prf_ivh"[\s\S]*?href="([^"]+)"[^>]*rel="nofollow"/i);
  if (homepageMatch) result.homepage = homepageMatch[1];

  // Avatar — the img uses srcset not src, grab the first URL (128w)
  const avatarMatch = html.match(/id="gsc_prf_pup-img"[^>]*srcset="([^"\s]+)/);
  if (avatarMatch) result.avatarUrl = avatarMatch[1];

  // Research interests
  result.interests = [...html.matchAll(/class="gsc_prf_inta[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) =>
    decodeHtmlEntities(m[1].trim()),
  );

  // Citation stats table
  const stdCells = [...html.matchAll(/class="gsc_rsb_std">(\d+)<\/td>/g)].map((m) =>
    parseInt(m[1], 10),
  );

  if (stdCells.length >= 6) {
    result.citations.all = stdCells[0];
    result.citations.recent = stdCells[1];
    result.hIndex.all = stdCells[2];
    result.hIndex.recent = stdCells[3];
    result.i10Index.all = stdCells[4];
    result.i10Index.recent = stdCells[5];
  } else {
    throw new Error(
      `Could not parse stats table — only found ${stdCells.length} cells. ` +
      "Scholar may have changed its HTML or blocked the request.",
    );
  }

  // Citation history (bar chart)
  // Years:  <span class="gsc_g_t" style="...">2023</span>
  // Values: <span class="gsc_g_al">31</span>
  const histYears = [...html.matchAll(/class="gsc_g_t"[^>]*>(\d{4})<\/span>/g)].map((m) =>
    parseInt(m[1], 10),
  );
  const histValues = [...html.matchAll(/class="gsc_g_al">(\d+)<\/span>/g)].map((m) =>
    parseInt(m[1], 10),
  );
  result.citationHistory = histYears.map((year, i) => ({
    year,
    citations: histValues[i] ?? 0,
  }));

  // Publications — scoped inside <tbody id="gsc_a_b">
  const tbodyMatch = html.match(/id="gsc_a_b"[^>]*>([\s\S]*?)<\/tbody>/);
  const tbody = tbodyMatch ? tbodyMatch[1] : html;
  const pubRows = [...tbody.matchAll(/<tr[^>]*class="gsc_a_tr"[^>]*>([\s\S]*?)<\/tr>/g)];

  for (const [, row] of pubRows) {
    // Title + link: <a href="..." class="gsc_a_at">Title</a>
    const titleMatch = row.match(/href="([^"]+)"[^>]*class="gsc_a_at"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? decodeHtmlEntities(stripTags(titleMatch[2])) : null;
    const link = titleMatch ? "https://scholar.google.com" + decodeHtmlEntities(titleMatch[1]) : null;

    // Authors & journal in <div class="gs_gray">
    const grayDivs = [...row.matchAll(/class="gs_gray">([\s\S]*?)<\/div>/g)].map((m) =>
      decodeHtmlEntities(stripTags(m[1])),
    );
    const authors = grayDivs[0] ?? null;
    // Strip nested <span class="gs_oph">, 2022</span> from journal
    const journal = grayDivs[1]
      ? decodeHtmlEntities(
        stripTags(grayDivs[1].replace(/<span[^>]*>[\s\S]*?<\/span>/g, "")).trim(),
      )
      : null;

    // Cited-by: <a ... class="gsc_a_ac gs_ibl">80</a>
    const citedMatch = row.match(/class="gsc_a_ac[^"]*"[^>]*>(\d+)<\/a>/);
    const citedBy = citedMatch ? parseInt(citedMatch[1], 10) : 0;

    // Year: <span class="gsc_a_h gsc_a_hc gs_ibl">2022</span>
    const yearMatch = row.match(/class="gsc_a_h gsc_a_hc[^"]*">(\d{4})<\/span>/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

    if (title) {
      result.publications.push({ title, authors, journal, citedBy, year, link });
    }
  }

  // Sort by cited-by descending (matches Scholar default)
  result.publications.sort((a, b) => b.citedBy - a.citedBy);

  return result;
}

// KV helpers

async function loadStats(kv) {
  const raw = await kv.get(KV_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function saveStats(kv, data) {
  await kv.put(KV_KEY, JSON.stringify(data));
}

// Security helpers

function getAllowedOrigins(env) {
  if (!env.ALLOWED_ORIGINS) return [];
  return env.ALLOWED_ORIGINS.split(",").map((o) => o.trim().toLowerCase());
}

function checkOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const allowed = getAllowedOrigins(env);
  if (allowed.length === 0) return origin;
  return allowed.includes(origin.toLowerCase()) ? origin : false;
}

/**
 * Validates x-api-key using SHA-256 hash comparison.
 * Store the HASH in Cloudflare secret API_KEY_HASH.
 * Send the RAW KEY in the x-api-key header.
 *
 * Generate key + hash:
 *   node -e "
 *     const c = require('crypto');
 *     const key = c.randomBytes(32).toString('hex');
 *     const hash = c.createHash('sha256').update(key).digest('hex');
 *     console.log('RAW KEY:', key);
 *     console.log('HASH:', hash);
 *   "
 */
async function checkApiKey(request, env) {
  // Legacy fallback: plain text comparison if only API_KEY is set
  if (env.API_KEY && !env.API_KEY_HASH) {
    return request.headers.get("x-api-key") === env.API_KEY;
  }
  // Neither configured — open access (useful for local dev)
  if (!env.API_KEY_HASH) return true;

  const incoming = request.headers.get("x-api-key");
  if (!incoming) return false;

  const encoded = new TextEncoder().encode(incoming);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex === env.API_KEY_HASH;
}

/**
 * Central auth gate.
 * Browser requests (Origin header present) → CORS origin allowlist.
 * Non-browser requests (curl, server-side) → API key check.
 */
async function authorize(request, env) {
  const origin = request.headers.get("Origin");

  if (origin) {
    const allowed = checkOrigin(request, env);
    if (allowed === false) {
      return { ok: false, origin: null, error: "Origin not allowed" };
    }
    return { ok: true, origin: allowed };
  } else {
    if (!(await checkApiKey(request, env))) {
      return { ok: false, origin: null, error: "Invalid or missing x-api-key" };
    }
    return { ok: true, origin: null };
  }
}

// Response helpers

const STATUS_TEXT = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
};

function jsonResponse(payload, statusCode = 200, allowedOrigin = null) {
  const body = {
    status: STATUS_TEXT[statusCode] ?? "Unknown",
    statusCode,
    ...payload,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
      Vary: "Origin",
    },
  });
}

// Request handler 

async function handleRequest(request, env) {
  const url = new URL(request.url);

  // OPTIONS pre-flight
  if (request.method === "OPTIONS") {
    const originCheck = checkOrigin(request, env);
    if (originCheck === false) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": originCheck ?? "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "x-api-key, Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }

  // GET / -- health check
  if (url.pathname === "/" && request.method === "GET") {
    const stats = await loadStats(env.SCHOLAR_KV);
    return jsonResponse({
      message: "Google Scholar Stats API",
      description:
        "Scrapes and caches Google Scholar profile stats once daily. Use GET /stats to retrieve data.",
      version: "1.0.0",
      endpoints: {
        "GET /": "Health check (this response)",
        "GET /stats": "Returns cached scholar stats — requires Origin allowlist or x-api-key header",
        "POST /refresh": "Triggers an immediate scrape — requires x-api-key header",
      },
      cache: {
        hasData: stats !== null,
        lastScraped: stats?.scrapedAt ?? null,
      },
    }, 200);
  }

  // GET /stats -- return cached data (requires auth)
  if (url.pathname === "/stats" && request.method === "GET") {
    const auth = await authorize(request, env);
    if (!auth.ok) {
      return jsonResponse({ message: auth.error }, 403, null);
    }

    const stats = await loadStats(env.SCHOLAR_KV);
    if (!stats) {
      return jsonResponse(
        { message: "No data yet. Trigger /refresh or wait for the daily cron." },
        404,
        auth.origin,
      );
    }
    return jsonResponse({ message: "Success", data: stats }, 200, auth.origin);
  }

  // POST /refresh -- manual scrape trigger
  if (url.pathname === "/refresh" && request.method === "POST") {
    const auth = await authorize(request, env);
    if (!auth.ok) {
      return jsonResponse({ message: auth.error }, 401);
    }

    try {
      const scholarUrl = env.SCHOLAR_URL;
      if (!scholarUrl) {
        return jsonResponse({ message: "SCHOLAR_URL environment variable not set." }, 500);
      }
      const stats = await scrapeScholarStats(scholarUrl);
      await saveStats(env.SCHOLAR_KV, stats);
      return jsonResponse({ message: "Data Successfully refreshed" }, 200);
    } catch (err) {
      return jsonResponse({ message: err.message }, 500);
    }
  }

  return jsonResponse({ message: "Not Found" }, 404);
}

// Scheduled handler (Cron)

async function handleScheduled(env) {
  const scholarUrl = env.SCHOLAR_URL;
  if (!scholarUrl) {
    console.error("SCHOLAR_URL not set — skipping scheduled scrape");
    return;
  }
  console.log("Cron: scraping", scholarUrl);
  const stats = await scrapeScholarStats(scholarUrl);
  await saveStats(env.SCHOLAR_KV, stats);
  console.log("Cron: saved stats for", stats.name);
}


export default {
  fetch: handleRequest,
  scheduled: (_event, env, _ctx) => handleScheduled(env),
};
