import matter from "gray-matter";

// Open Knowledge Format (OKF) v0.2 concept document: a markdown file with a
// YAML frontmatter block plus a body. We only need to read concept files
// (not author/validate whole bundles), so this covers the subset relevant to
// ingestion: the required `type` field, and the recommended/optional fields
// worth carrying through as retrieval-time metadata.
// Spec: https://github.com/GoogleCloudPlatform/open-knowledge-format
export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: "draft" | "stable" | "deprecated";
  stale_after?: string;
  generated?: { by: string; at?: string };
  verified?: { by: string; at?: string }[];
  sources?: { id?: string; resource: string; title?: string }[];
}

export interface OkfDocument {
  frontmatter: OkfFrontmatter;
  body: string;
}

// A concept document without a non-empty `type` field is not conformant with
// OKF v0.2 (see SPEC.md, conformance rule 2). We fail ingestion outright
// rather than ingesting untyped content, since we're authoring these files
// ourselves - unlike a consumer of a third-party bundle, we have no reason to
// tolerate our own non-conformant output.
export function parseOkfDocument(raw: string): OkfDocument {
  const { data, content } = matter(raw);

  if (typeof data.type !== "string" || data.type.trim().length === 0) {
    throw new Error('OKF document is missing a required, non-empty "type" frontmatter field.');
  }

  return {
    frontmatter: data as OkfFrontmatter,
    body: content.trim(),
  };
}
