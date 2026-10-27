import express from "express";
import { GitHubError } from "./client.js";
import { SecretsConfigError } from "./secrets.js";
import { ServiceError } from "./service.js";

// Mounted under /api after requireAuth, so req.user is always the caller:
//   GET    /api/integrations/github     connection status (never the token)
//   PUT    /api/integrations/github     { repo, token?, ref?, uploadScreenshots? } connect / update
//   DELETE /api/integrations/github     disconnect
//   POST   /api/bugs/:key/ticket        { url? } create (or reuse) the issue
//   GET    /api/bugs/:key/source        ?url=  likely source-code location
//   GET    /api/bugs/:key/screenshot    ?url=  the bug's screenshot (PNG)
// Bugs are looked up among the caller's own scans only; paths and locations
// come from the server's records, never from the request.

// GitHub problems the user can fix themselves are 400s; GitHub being down or
// unreachable is a 502.
const GITHUB_STATUS = {
  rate_limited: 429,
  invalid_token: 400,
  no_permission: 400,
  not_found: 400,
  issues_disabled: 400,
  validation: 400,
};

function sendError(res, err) {
  if (err instanceof ServiceError) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  if (err instanceof GitHubError) {
    return res.status(GITHUB_STATUS[err.code] || 502).json({ success: false, code: err.code, error: err.message });
  }
  if (err instanceof SecretsConfigError) {
    console.error(`GitHub integration: ${err.message}`);
    return res.status(503).json({
      success: false,
      code: "not_configured",
      error: "GitHub integration isn't set up on this server (GITHUB_TOKEN_ENCRYPTION_KEY is missing).",
    });
  }
  console.error("GitHub integration error:", err?.message || err);
  return res.status(500).json({ success: false, error: "Something went wrong on the server" });
}

export function githubRouter(service) {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (err) {
      sendError(res, err);
    }
  };

  router.get("/integrations/github", handle((req) => service.getConnection(req.user._id)));
  router.put(
    "/integrations/github",
    handle((req) =>
      service.connect(req.user._id, {
        repo: req.body?.repo,
        token: req.body?.token,
        ref: req.body?.ref,
        uploadScreenshots: req.body?.uploadScreenshots,
      }),
    ),
  );
  router.delete("/integrations/github", handle((req) => service.disconnect(req.user._id)));
  router.post(
    "/bugs/:key/ticket",
    handle((req) => service.createTicket(req.user._id, req.params.key, { url: req.body?.url })),
  );
  router.get(
    "/bugs/:key/source",
    handle((req) => service.locate(req.user._id, req.params.key, { url: req.query.url })),
  );
  router.get("/bugs/:key/screenshot", async (req, res) => {
    try {
      const file = await service.screenshotPath(req.user._id, req.params.key, { url: req.query.url });
      if (!file) return res.status(404).json({ success: false, code: "no_screenshot", error: "No screenshot for this bug." });
      res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.type("png").sendFile(file);
    } catch (err) {
      sendError(res, err);
    }
  });
  return router;
}
