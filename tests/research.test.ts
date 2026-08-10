import assert from "node:assert/strict";
import test from "node:test";
import {
  searchArxiv,
  searchOpenAlex,
  searchSemanticScholar,
} from "../lib/research";

test("research adapters separate citation and open-access retrieval URLs", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({
      results: [{
        id: "https://openalex.org/W1",
        doi: "https://doi.org/10.1/example",
        title: "Open paper",
        publication_date: "2026-08-01",
        authorships: [],
        cited_by_count: 1,
        open_access: { is_oa: true, oa_url: "https://repo.example/paper" },
        primary_location: {
          landing_page_url: "https://journal.example/article",
          pdf_url: "https://cdn.example/article.pdf",
        },
      }],
    })) as typeof fetch;
    const [openAlex] = await searchOpenAlex("systems");
    assert.equal(openAlex.canonicalUrl, "https://journal.example/article");
    assert.equal(openAlex.documentUrl, "https://cdn.example/article.pdf");

    globalThis.fetch = (async () => Response.json({
      data: [{
        paperId: "S1",
        title: "Semantic paper",
        abstract: "Evidence.",
        authors: [],
        year: 2026,
        citationCount: 2,
        url: "https://semanticscholar.org/paper/S1",
        openAccessPdf: { url: "https://pdfs.example/S1.pdf" },
      }],
    })) as typeof fetch;
    const [semanticScholar] = await searchSemanticScholar("systems");
    assert.equal(
      semanticScholar.canonicalUrl,
      "https://semanticscholar.org/paper/S1",
    );
    assert.equal(semanticScholar.documentUrl, "https://pdfs.example/S1.pdf");

    globalThis.fetch = (async () => new Response(`<?xml version="1.0"?>
      <feed><entry><id>https://arxiv.org/abs/2608.00001v2</id>
      <title>ArXiv paper</title><summary>Evidence.</summary>
      <published>2026-08-01T00:00:00Z</published></entry></feed>`)) as typeof fetch;
    const [arxiv] = await searchArxiv("systems");
    assert.equal(arxiv.canonicalUrl, "https://arxiv.org/abs/2608.00001v2");
    assert.equal(arxiv.documentUrl, "https://arxiv.org/pdf/2608.00001.pdf");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
