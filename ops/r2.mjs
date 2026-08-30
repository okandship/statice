// Minimal SigV4-signed R2 client. No dependencies.
//
// Used only by the standing habits, which read and never delete: the token
// these credentials come from is scoped Object Read-only, because nothing that
// can delete runs unattended.

import { createHash, createHmac } from "node:crypto";

const REGION = "auto";
const SERVICE = "s3";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding; S3 wants the path encoded but `/` left alone. */
function uriEncode(s, encodeSlash = true) {
  let out = "";
  for (const ch of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/" && !encodeSlash) out += c;
    else out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function makeClient({ accountId, accessKeyId, secretAccessKey }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;

  async function signedFetch(method, path, query = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex("");

    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`)
      .join("&");

    const canonicalHeaders =
      `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = [
      method, uriEncode(path, false), canonicalQuery,
      canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest),
    ].join("\n");

    let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
    key = hmac(key, REGION);
    key = hmac(key, SERVICE);
    key = hmac(key, "aws4_request");
    const signature = hmac(key, stringToSign).toString("hex");

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}${uriEncode(path, false)}` +
      (canonicalQuery ? `?${canonicalQuery}` : "");
    return fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
    });
  }

  /** Every key under a prefix, following continuation tokens. */
  async function list(bucket, prefix) {
    const keys = [];
    let token;
    do {
      const query = { "list-type": "2", prefix, "max-keys": "1000" };
      if (token) query["continuation-token"] = token;
      const res = await signedFetch("GET", `/${bucket}`, query);
      const xml = await res.text();
      if (!res.ok) throw new Error(`list ${prefix}: ${res.status} ${xml.slice(0, 300)}`);
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]));
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
      token = next ? decodeXml(next[1]) : undefined;
    } while (token);
    return keys;
  }

  async function get(bucket, key) {
    const res = await signedFetch("GET", `/${bucket}/${key}`);
    if (!res.ok) throw new Error(`get ${key}: ${res.status}`);
    return res.text();
  }

  return { list, get };
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
