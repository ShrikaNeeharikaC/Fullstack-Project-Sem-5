import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { analyzePageWorkflow } from "./browser.js";

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, error: "URL is required" });
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return res
        .status(400)
        .json({
          success: false,
          error: "Only http and https URLs are allowed",
        });
    }
  } catch (err) {
    return res.status(400).json({ success: false, error: "Invalid URL" });
  }

  try {
    const result = await analyzePageWorkflow(url);
    res.json({ success: true, url, analysis: result });
  } catch (err) {
    console.error("Analysis error:", err);
    res
      .status(500)
      .json({
        success: false,
        error: err.message || "An unexpected error occurred during analysis.",
      });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
