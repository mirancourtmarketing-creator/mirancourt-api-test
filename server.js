import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

// POST /contact → forward to Make webhook
app.post("/contact", async (req, res) => {
  try {
    const payload = req.body;

    // Forward to Make webhook
    const response = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Make webhook error: ${response.statusText}`);
    }

    res.status(200).json({ ok: true, message: "Lead submitted successfully." });
  } catch (err) {
    console.error("Error forwarding lead:", err.message);
    res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
