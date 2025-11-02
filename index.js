// index.js (ES module style)
import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import axios from "axios";
import Tesseract from "tesseract.js";
import FormData from "form-data";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import MarkdownIt from "markdown-it";
import "dotenv/config";
import cors from "cors";

const md = new MarkdownIt();
const app = express();
app.use(cors());
app.use(express.json());

const s3 = new S3Client({ region: process.env.AWS_REGION });
const transcribe = new TranscribeClient({ region: process.env.AWS_REGION });
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION });

const upload = multer({ dest: "uploads/", limits: { fileSize: 500 * 1024 * 1024 } });

const safeCleanup = async (paths = []) => {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        if (fs.lstatSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
      }
    } catch (err) {
      console.warn("⚠️ Cleanup skipped for:", p, err.message);
    }
  }
};

app.get("/", (req, res) => res.send("SmartClassroom AI backend running"));

app.post("/process", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });

  const videoPath = req.file.path;
  const audioPath = `${videoPath}.wav`;
  const framesDir = path.join("frames", path.basename(videoPath));
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    // 1) Extract audio
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

    // 2) Extract frames (1 every 5s)
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on("end", resolve)
        .on("error", reject)
        .output(path.join(framesDir, "frame-%04d.jpg"))
        .outputOptions(["-vf", "fps=1/5"])
        .run();
    });

    // 3) OCR frames (sequential)
    let visualText = "";
    const frameFiles = fs.readdirSync(framesDir).sort();
    for (const file of frameFiles) {
      const framePath = path.join(framesDir, file);
      try {
        const result = await Tesseract.recognize(framePath, "eng");
        const txt = (result?.data?.text || "").trim();
        if (txt) visualText += txt + "\n";
      } catch (e) {
        console.warn("OCR error for", framePath, e.message);
      }
    }

    // 4) Upload audio to S3
    const audioBuffer = fs.readFileSync(audioPath);
    const s3KeyAudio = `audio/${path.basename(audioPath)}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: s3KeyAudio,
      Body: audioBuffer,
      ContentType: "audio/wav",
    }));
    const s3UriAudio = `s3://${process.env.AWS_S3_BUCKET}/${s3KeyAudio}`;

    // 5) Start Transcribe job
    const jobName = `lectureTranscription-${Date.now()}`;
    await transcribe.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: "en-US",
      Media: { MediaFileUri: s3UriAudio },
      OutputBucketName: process.env.AWS_S3_BUCKET,
    }));

    // Poll for completion
    let transcript = "";
    for (;;) {
      const job = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
      const status = job.TranscriptionJob.TranscriptionJobStatus;
      if (status === "COMPLETED") {
        const transcriptUri = job.TranscriptionJob.Transcript.TranscriptFileUri;
        const resp = await axios.get(transcriptUri);
        transcript = resp.data.results?.transcripts?.map(t => t.transcript).join("\n") || "";
        break;
      } else if (status === "FAILED") {
        throw new Error("Transcription failed");
      }
      await new Promise(r => setTimeout(r, 4000));
    }

    // 6) Prompt prep
    const systemPrompt = `
You are **SmartClassroom AI**, a world-class academic assistant built for educators and students.
Your job is to process lectures and generate complete, structured study material.

### Your Output Must Include:
1. 📖 Comprehensive Lecture Summary (structured, divided by subtopics).
2. 🧾 Detailed Class Notes (markdown friendly: definitions, formulas, examples).
3. 🎯 Key Topics / Keywords (5–10 items).
4. 📚 References / Mentions (if any).
5. 💡 Important Questions — generate 3–5 of each:
   - MCQs (4 options, mark correct)
   - Short Questions (1–2 line answers)
   - Long Questions (3–4 line sample answers)
6. 🔁 Quick Revision Points (5 bullet takeaways).

Style: Use headings, bullets, and emojis for readability. Base questions strictly on lecture content.
    `.trim();

    const userPrompt = `
🎥 Lecture Transcript:
${transcript}

🖼️ Extracted Visual Text:
${visualText}

Please generate the structured output following the instructions.
    `.trim();

    // 7) Call Bedrock (Llama 3 70B Instruct)
    const modelId = "meta.llama3-70b-instruct-v1:0";
    const bedrockBody = {
      prompt: `${systemPrompt}\n\nUser Request:\n${userPrompt}`,
      max_gen_len: 3000,
      temperature: 0.7,
      top_p: 0.9
    };

    const bedrockResp = await bedrock.send(new InvokeModelCommand({
      modelId,
      body: JSON.stringify(bedrockBody),
      contentType: "application/json",
      accept: "application/json"
    }));

    const bodyStr = await bedrockResp.body.transformToString();
    let parsed;
    try { parsed = JSON.parse(bodyStr); } catch (e) { parsed = { raw: bodyStr }; }

    // Robust extraction of text from possible response shapes
    let finalNotes = "";
    if (parsed.output_text) finalNotes = parsed.output_text;
    else if (parsed.generation) finalNotes = (typeof parsed.generation === "string") ? parsed.generation : JSON.stringify(parsed.generation);
    else if (parsed.outputs?.[0]?.content?.[0]?.text) finalNotes = parsed.outputs[0].content[0].text;
    else if (parsed.outputs?.[0]?.text) finalNotes = parsed.outputs[0].text;
    else if (parsed.output) finalNotes = parsed.output;
    else finalNotes = bodyStr;

    if (!finalNotes || finalNotes.trim().length < 10) {
      finalNotes = "⚠️ Model returned empty output. Transcript length: " + transcript.length;
    }

    // --- 8) Generate Classic PDF (PDFKit) ---
    const classicPdfPath = `${videoPath}-classic.pdf`;
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
      const stream = fs.createWriteStream(classicPdfPath);
      stream.on("finish", resolve);
      stream.on("error", reject);
      doc.pipe(stream);

      // Header
      doc.fontSize(20).fillColor("#0066CC").font("Helvetica-Bold").text("📘 SmartClassroom Lecture Notes", { align: "center" }).moveDown(1);

      // Split into logical sections by detecting headings
      const sections = {
        summary: "", notes: "", keytopics: "", references: "", questions: "", revision: ""
      };
      let current = "summary";
      finalNotes.split("\n").forEach(rawLine => {
        const line = rawLine.trim();
        const lower = line.toLowerCase();
        if (lower.match(/^(#*\s*)?summary\b/) || lower.includes("comprehensive lecture summary")) { current = "summary"; return; }
        if (lower.includes("class notes") || lower.includes("detailed class notes")) { current = "notes"; return; }
        if (lower.includes("key topics") || lower.includes("keywords")) { current = "keytopics"; return; }
        if (lower.includes("references")) { current = "references"; return; }
        if (lower.includes("important questions") || lower.includes("mcq") || lower.includes("questions")) { current = "questions"; return; }
        if (lower.includes("revision") || lower.includes("quick revision")) { current = "revision"; return; }
        sections[current] += rawLine + "\n";
      });

      const sectionStyles = {
        summary: { color: "#007ACC", emoji: "🧭" },
        notes: { color: "#009B77", emoji: "🧾" },
        keytopics: { color: "#FF8C00", emoji: "🎯" },
        references: { color: "#8A2BE2", emoji: "📚" },
        questions: { color: "#D72638", emoji: "💡" },
        revision: { color: "#00BFFF", emoji: "🔁" }
      };

      const renderTextBlock = (text, style) => {
        if (!text.trim()) return;
        doc.moveDown(0.5).fontSize(14).fillColor(style.color).font("Helvetica-Bold").text(`${style.emoji} ${style.title || ""}`, { continued: false }).moveDown(0.2);
        // render lines
        const lines = md.render(text).replace(/<\/?[^>]+(>|$)/g, "").split("\n").filter(l=>l.trim() !== "");
        for (const ln of lines) {
          const s = ln.trim();
          if (s.match(/^\d+\.\s/)) {
            doc.fontSize(11).fillColor("#222").font("Helvetica").text(s, { indent: 12 }).moveDown(0.1);
          } else if (s.match(/^[-*•]\s/)) {
            doc.fontSize(11).fillColor("#222").font("Helvetica").text("• " + s.replace(/^[-*•]\s*/, ""), { indent: 16 }).moveDown(0.1);
          } else {
            doc.fontSize(11).fillColor("#333").font("Helvetica").text(s).moveDown(0.1);
          }
        }
      };

      // add title per section
      for (const key of ["summary","notes","keytopics","references","questions","revision"]) {
        const style = sectionStyles[key];
        style.title = {
          summary: "Comprehensive Lecture Summary",
          notes: "Detailed Class Notes",
          keytopics: "Key Topics / Keywords",
          references: "References / Mentions",
          questions: "Important Questions",
          revision: "Quick Revision Points"
        }[key];
        renderTextBlock(sections[key], style);
      }

      // footer on each page
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fontSize(9).fillColor("#777").text("Generated by SmartClassroom AI 🧠", 40, doc.page.height - 50, { align: "center", width: doc.page.width - 80 });
      }

      doc.end();
    });

    // --- 9) Generate Modern PDF via Puppeteer (if available) ---
    const modernPdfPath = `${videoPath}-modern.pdf`;
    let modernPdfCreated = false;
    try {
      const puppeteer = await import('puppeteer');
      const html = `
      <html><head><meta charset="utf-8"/>
      <style>
        body{font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,"Helvetica Neue",Arial; padding:40px; color:#222;}
        h1{color:#007ACC; text-align:center}
        h2{color:#009B77}
        .section{margin-top:18px}
        .card{background:#f7fbff;padding:12px;border-left:6px solid #007ACC;border-radius:8px}
        .footer{position:fixed;bottom:10px;width:100%;text-align:center;color:#888;font-size:12px}
      </style></head>
      <body>
        <h1>📘 SmartClassroom Lecture Notes</h1>
        ${md.render(finalNotes)}
        <div class="footer">Generated by SmartClassroom AI 🧠</div>
      </body></html>`;
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      await page.pdf({ path: modernPdfPath, format: "A4", printBackground: true });
      await browser.close();
      modernPdfCreated = fs.existsSync(modernPdfPath);
    } catch (err) {
      console.warn("Puppeteer not available or failed — skipping modern PDF. Error:", err.message);
    }

    // 10) Upload modern PDF if exists else classic PDF
    const pdfToUpload = (modernPdfCreated ? `${videoPath}-modern.pdf` : `${videoPath}-classic.pdf`);
    const pdfBuffer = fs.readFileSync(pdfToUpload);
    const s3KeyPdf = `notes/${path.basename(pdfToUpload)}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: s3KeyPdf,
      Body: pdfBuffer,
      ContentType: "application/pdf",
    }));
    const s3UrlPdf = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3KeyPdf}`;

    // respond
    res.json({
      success: true,
      pdfUrl: s3UrlPdf,
      classicPdfLocal: `${videoPath}-classic.pdf`,
      modernPdfLocal: modernPdfCreated ? `${videoPath}-modern.pdf` : null,
      transcriptLength: transcript.length
    });

    // final cleanup
    await safeCleanup([framesDir, audioPath, videoPath, `${videoPath}-classic.pdf`, modernPdfCreated ? null : null /* keep modern if created? remove if you want */].filter(Boolean));

  } catch (err) {
    console.error("Processing error:", err);
    await safeCleanup([framesDir, `${videoPath}.wav`, videoPath]);
    res.status(500).json({ error: err.message || "Processing failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
