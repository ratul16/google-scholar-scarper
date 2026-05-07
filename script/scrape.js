import fetch from "node-fetch";

const { SCHOLAR_URL, WORKER_URL, API_KEY } = process.env;

if (!SCHOLAR_URL || !WORKER_URL || !API_KEY) {
    console.error("Missing required env vars: SCHOLAR_URL, WORKER_URL, API_KEY");
    process.exit(1);
}

const SCHOLAR_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrape() {
    const url = new URL(SCHOLAR_URL);
    url.searchParams.set("pagesize", "100");

    console.log("Fetching Scholar profile:", url.toString());

    let html = null;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url.toString(), { headers: SCHOLAR_HEADERS });

        if (res.ok) {
            html = await res.text();
            console.log(`Fetched HTML (${html.length} bytes)`);
            break;
        }

        console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: HTTP ${res.status}`);
        if (attempt < MAX_RETRIES) await sleep(5000);
    }

    if (!html) {
        throw new Error("Failed to fetch Scholar page after all retries");
    }

    // Sanity check — if Google returned a CAPTCHA page the stats table won't be present
    if (!html.includes("gsc_rsb_std")) {
        throw new Error(
            "Scholar HTML does not contain expected stats table — likely a CAPTCHA or block page",
        );
    }

    console.log("Posting HTML to Worker /ingest...");

    const ingest = await fetch(`${WORKER_URL}/ingest`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
        },
        body: JSON.stringify({ html, profileUrl: SCHOLAR_URL }),
    });

    const result = await ingest.json();
    console.log("Worker response:", JSON.stringify(result, null, 2));

    if (!ingest.ok) {
        throw new Error(`Worker ingest failed (${ingest.status}): ${result.message}`);
    }

    console.log(`Done. Ingested ${result.publications} publications, ${result.citations} total citations.`);
}

scrape().catch((err) => {
    console.error("Scrape failed:", err.message);
    process.exit(1);
});
