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

  return new Request(url, {
    method: req.method,
    headers,
    duplex: "half",
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : Readable.toWeb(req),
  });
}

/**
 * Send a standard Response back through Express.
 *
 * @param {import("express").Response} res - Express response
 * @param {Response} response - Standard Response from federation.fetch()
 */
async function sendFedifyResponse(res, response) {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
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
