import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import PDFDocument from "pdfkit";
import axios from "axios";
import Tesseract from "tesseract.js";
import FormData from "form-data";
import "dotenv/config";
import cors from "cors";

const app = express();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const safeCleanup = async (paths = []) => {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        if (fs.lstatSync(p).isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          fs.unlinkSync(p);
        }
      }
    } catch (err) {
      console.warn("⚠️ Cleanup skipped for:", p, err.message);
    }
  }
};
app.use(cors());
app.get("/", (req, res) => {
  res.send("📚 Smart Classroom Assistant is running. Use POST /process to upload a lecture video.");
});
// ---- Main Endpoint ----
app.post("/process", upload.single("video"), async (req, res) => {
  const videoPath = req.file.path;
  const audioPath = `${videoPath}.wav`;
  const framesDir = path.join("frames", path.basename(videoPath));
  fs.mkdirSync(framesDir, { recursive: true });

  console.log("🎥 Received video:", videoPath);

  try {
    // 1️⃣ Extract audio
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec("pcm_s16le")
        .audioChannels(1)
        .audioFrequency(16000)
        .save(audioPath)
        .on("end", resolve)
        .on("error", reject);
    });
    console.log("🎧 Audio extracted:", audioPath);

    // 2️⃣ Extract frames (1 every 5 seconds)
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on("end", resolve)
        .on("error", reject)
        .output(path.join(framesDir, "frame-%04d.jpg"))
        .outputOptions(["-vf", "fps=1/5"])
        .run();
    });
    console.log("🖼️ Frames extracted to:", framesDir);

    // 3️⃣ OCR on frames
    let visualText = "";
    const files = fs.readdirSync(framesDir);
    for (const file of files) {
      const framePath = path.join(framesDir, file);
      const result = await Tesseract.recognize(framePath, "eng");
      visualText += "\n" + result.data.text;
      console.log("🔍 OCR done for:", file);
    }
    console.log("📄 Visual text extracted from frames:", visualText);

    // 4️⃣ Transcribe audio (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });
    const transcript = transcription.text;
    console.log("📝 Transcription complete",transcript);

    // 5️⃣ Combine & Summarize with LLM
    const prompt = `
You are an intelligent classroom assistant.
Use the following lecture transcript and visuals text to generate:
1. Summary
2. Detailed class notes
3. Key topics
4. References (if any)

--- Transcript ---
${transcript}

--- Visuals (slides / board text) ---
${visualText}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const finalNotes = completion.choices[0].message.content;
    console.log("🧠 Lecture summary generated.");

    // 6️⃣ Create PDF
    const pdfPath = `${videoPath}.pdf`;
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdfPath));
    doc.fontSize(14).text("📘 Smart Classroom Lecture Notes", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(finalNotes);
    doc.end();
    console.log("📄 PDF created:", pdfPath);

    // 7️⃣ Send PDF via Telegram
    //await sendToTelegram(pdfPath);

    // Cleanup
    console.log(audioPath, videoPath, framesDir);
    //await safeCleanup([framesDir, audioPath, videoPath, pdfPath]);

    res.send("✅ Lecture processed successfully and sent to Telegram!");
  } catch (err) {
    console.error("❌ Error:", err);
    //await safeCleanup([framesDir, audioPath, videoPath]);
    res.status(500).send("Error processing lecture.");
  }
});

// ---- Telegram Sender ----
async function sendToTelegram(filePath) {
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const form = new FormData();
  form.append("chat_id", CHAT_ID);
  form.append("document", fs.createReadStream(filePath));

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, form, {
    headers: form.getHeaders(),
  });

  console.log("📨 PDF sent to Telegram.");
}

// ---- Start Server ----
app.listen(5000, "0.0.0.0", () => console.log("🚀 Server ready at http://<your-pi-ip>:5000"));
