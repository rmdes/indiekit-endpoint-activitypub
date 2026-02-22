/**
 * Express ↔ Fedify bridge.
 *
 * Converts Express requests to standard Request objects and delegates
 * to federation.fetch(). We can't use @fedify/express's integrateFederation()
 * because Indiekit plugins mount routes at a sub-path (e.g. /activitypub),
 * which causes req.url to lose the mount prefix. Instead, we use
 * req.originalUrl to preserve the full path that Fedify's URI templates expect.
 */

import { Readable } from "node:stream";
import { Buffer } from "node:buffer";

/**
 * Convert an Express request to a standard Request with the full URL.
 *
 * @param {import("express").Request} req - Express request
 * @returns {Request} Standard Request object
 */
export function fromExpressRequest(req) {
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === "string") {
      headers.append(key, value);
    }
  }

  let body;
  if (req.method === "GET" || req.method === "HEAD") {
    body = undefined;
  } else if (!req.readable && req.body) {
    // Express body parser already consumed the stream — reconstruct
    // so downstream handlers (e.g. @fedify/debugger login) can read it.
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")) {
      body = JSON.stringify(req.body);
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(req.body).toString();
    } else {
      body = undefined;
    }
  } else {
    body = Readable.toWeb(req);
  }

  return new Request(url, {
    method: req.method,
    headers,
    duplex: "half",
    body,
  });
}

/**
 * Send a standard Response back through Express.
 *
 * @param {import("express").Response} res - Express response
 * @param {Response} response - Standard Response from federation.fetch()
 * @param {Request} [request] - Original request (for targeted patching)
 */
async function sendFedifyResponse(res, response, request) {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body || response.bodyUsed) {
    res.end();
    return;
  }

  // WORKAROUND: Fedify serializes endpoints with "type": "as:Endpoints"
  // which is not a real ActivityStreams type (fails browser.pub validation).
  // For actor JSON responses, buffer the body and strip the invalid type.
  // See: https://github.com/fedify-dev/fedify/issues/576
  // TODO: Remove this workaround when Fedify fixes the upstream issue.
  const contentType = response.headers.get("content-type") || "";
  const isActorJson =
    contentType.includes("activity+json") ||
    contentType.includes("ld+json");

  if (isActorJson) {
    const body = await response.text();
    try {
      const json = JSON.parse(body);
      if (json.endpoints?.type) {
        delete json.endpoints.type;
      }
      const patched = JSON.stringify(json);
      res.setHeader("content-length", Buffer.byteLength(patched));
      res.end(patched);
    } catch {
      // Not valid JSON — send as-is
      res.end(body);
    }
    return;
  }

  const reader = response.body.getReader();
  await new Promise((resolve) => {
    function read({ done, value }) {
      if (done) {
        reader.releaseLock();
        resolve();
        return;
      }
      res.write(Buffer.from(value));
      reader.read().then(read);
    }
    reader.read().then(read);
  });
  res.end();
}

/**
 * Create Express middleware that delegates to Fedify's federation.fetch().
 *
 * On 404 (Fedify didn't match), calls next().
 * On 406 (not acceptable), calls next() so Express can try other handlers.
 * Otherwise, sends the Fedify response directly.
 *
 * @param {import("@fedify/fedify").Federation} federation
 * @param {Function} contextDataFactory - (req) => contextData
 * @returns {import("express").RequestHandler}
 */
export function createFedifyMiddleware(federation, contextDataFactory) {
  return async (req, res, next) => {
    try {
      const request = fromExpressRequest(req);
      const contextData = await Promise.resolve(contextDataFactory(req));

      let notFound = false;
      let notAcceptable = false;

      const response = await federation.fetch(request, {
        contextData,
        onNotFound: () => {
          notFound = true;
          return new Response("Not found", { status: 404 });
        },
        onNotAcceptable: () => {
          notAcceptable = true;
          return new Response("Not acceptable", {
            status: 406,
            headers: { "Content-Type": "text/plain", Vary: "Accept" },
          });
        },
      });

      if (notFound || notAcceptable) {
        return next();
      }

      await sendFedifyResponse(res, response);
    } catch (error) {
      next(error);
    }
  };
}
