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
import "dotenv/config";
import cors from "cors";
import MarkdownIt from "markdown-it";
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
//get endpoint
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>🎓 Smart Classroom Recorder</title>
  <style>
    body {
      font-family: 'Poppins', sans-serif;
      background: linear-gradient(135deg, #e3f2fd, #bbdefb);
      color: #222;
      text-align: center;
      padding: 40px;
    }
    h1 {
      color: #0047AB;
      margin-bottom: 20px;
    }
    video {
      width: 80%;
      max-width: 700px;
      border-radius: 12px;
      border: 3px solid #1976d2;
      box-shadow: 0 5px 15px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    button {
      background-color: #1565C0;
      border: none;
      color: white;
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 10px;
      cursor: pointer;
      margin: 5px;
      transition: all 0.3s ease;
    }
    button:hover { background-color: #0d47a1; }

    .mode-toggle {
      margin-bottom: 30px;
    }
    .mode-btn {
      background: #64b5f6;
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      margin: 5px;
      cursor: pointer;
    }
    .mode-btn.active {
      background: #1565C0;
    }

    .loader-section {
      display: none;
      margin-top: 30px;
      text-align: center;
    }
    .loader-item {
      margin: 15px auto;
      width: 70%;
      background: #fff;
      border-radius: 10px;
      padding: 10px 15px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      text-align: left;
    }
    .loader-bar {
      width: 100%;
      background: #eee;
      border-radius: 10px;
      height: 14px;
      overflow: hidden;
      margin-top: 6px;
    }
    .loader-fill {
      height: 100%;
      background: linear-gradient(90deg, #42a5f5, #1e88e5);
      width: 0%;
      transition: width 0.6s ease;
      border-radius: 10px;
    }
    .loader-text {
      font-size: 14px;
      margin-bottom: 4px;
      color: #333;
    }
    .completed { color: #00c853; font-weight: bold; }
    .log {
      background: #fff;
      padding: 15px;
      border-radius: 12px;
      width: 70%;
      margin: 20px auto;
      text-align: left;
      box-shadow: 0 4px 10px rgba(0,0,0,0.08);
      display: none;
    }
    #pdfLink {
      display: none;
      margin-top: 25px;
      background: #00c853;
    }
  </style>
</head>
<body>
  <h1>🎥 Smart Classroom Recorder</h1>

  <div class="mode-toggle">
    <button id="recordModeBtn" class="mode-btn active">🎤 Record Live</button>
    <button id="uploadModeBtn" class="mode-btn">📂 Upload Video</button>
  </div>

  <!-- Recording Section -->
  <div id="recordSection">
    <video id="preview" autoplay muted></video><br>
    <button id="startBtn">Start Recording</button>
    <button id="stopBtn" disabled>Stop Recording</button>
  </div>

  <!-- Upload Section -->
  <div id="uploadSection" style="display:none;">
    <h2>🎞️ Upload a Recorded Lecture</h2>
    <input type="file" id="videoFile" accept="video/*">
    <button id="uploadBtn">Upload & Process</button>
  </div>

  <!-- Progress Loader Section -->
  <div class="loader-section" id="loaderSection">
    <h2>⏳ Processing Lecture...</h2>

    <div class="loader-item" id="step1">
      <div class="loader-text">🎙️ Extracting Lecture Audio...</div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
    </div>
    <div class="loader-item" id="step2">
      <div class="loader-text">🧠 Performing OCR on Lecture Slides...</div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
    </div>
    <div class="loader-item" id="step3">
      <div class="loader-text">💬 Transcribing Speech to Text...</div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
    </div>
    <div class="loader-item" id="step4">
      <div class="loader-text">✍️ Generating Notes & Saving PDF...</div>
      <div class="loader-bar"><div class="loader-fill"></div></div>
    </div>
  </div>

  <div class="log" id="logBox"></div>

  <button id="pdfLink" onclick="window.open(this.dataset.url, '_blank')">📘 View Generated Notes PDF</button>

  <script>
    let recorder, stream;
    const logBox = document.getElementById("logBox");
    const loaderSection = document.getElementById("loaderSection");
    const pdfLink = document.getElementById("pdfLink");

    const recordSection = document.getElementById("recordSection");
    const uploadSection = document.getElementById("uploadSection");
    const recordModeBtn = document.getElementById("recordModeBtn");
    const uploadModeBtn = document.getElementById("uploadModeBtn");

    // === MODE SWITCHING ===
    recordModeBtn.onclick = () => {
      recordModeBtn.classList.add("active");
      uploadModeBtn.classList.remove("active");
      recordSection.style.display = "block";
      uploadSection.style.display = "none";
    };
    uploadModeBtn.onclick = () => {
      uploadModeBtn.classList.add("active");
      recordModeBtn.classList.remove("active");
      recordSection.style.display = "none";
      uploadSection.style.display = "block";
    };

    function logMessage(msg) {
      logBox.style.display = "block";
      logBox.innerHTML += "• " + msg + "<br>";
    }

    // === Sequential Loader Animation ===
    function startSimulatedProgress() {
      loaderSection.style.display = "block";
      const steps = document.querySelectorAll(".loader-item");
      let stepIndex = 0;

      const interval = setInterval(() => {
        if (stepIndex < steps.length) {
          const fill = steps[stepIndex].querySelector(".loader-fill");
          const text = steps[stepIndex].querySelector(".loader-text");
          fill.style.width = "100%";
          text.innerHTML += " ✅";
          text.classList.add("completed");
          stepIndex++;
        } else {
          clearInterval(interval);
        }
      }, 2500);
    }

    async function sendToBackend(formData) {
      startSimulatedProgress();

      try {
        const response = await fetch("/process", { method: "POST", body: formData });
        const data = await response.json();

        if (data.success) {
          logMessage("✅ Notes generated successfully.");
          pdfLink.dataset.url = data.pdfUrl;
          pdfLink.style.display = "inline-block";
          logMessage("📄 PDF URL: " + data.pdfUrl);
        } else {
          logMessage("❌ Error generating notes.");
        }
      } catch (err) {
        logMessage("❌ Error: " + err.message);
      }
    }

    // === RECORD MODE ===
    document.getElementById("startBtn").onclick = async () => {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById("preview").srcObject = stream;
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const formData = new FormData();
        formData.append("video", blob, "lecture.webm");
        logMessage("🎬 Uploading and processing lecture...");
        await sendToBackend(formData);
      };

      recorder.start();
      logMessage("🎥 Recording started...");
      document.getElementById("startBtn").disabled = true;
      document.getElementById("stopBtn").disabled = false;
    };

    document.getElementById("stopBtn").onclick = () => {
      recorder.stop();
      stream.getTracks().forEach(track => track.stop());
      logMessage("🛑 Recording stopped.");
      document.getElementById("stopBtn").disabled = true;
    };

    // === UPLOAD MODE ===
    document.getElementById("uploadBtn").onclick = async () => {
      const fileInput = document.getElementById("videoFile");
      const file = fileInput.files[0];
      if (!file) {
        alert("Please select a video file first.");
        return;
      }

      const formData = new FormData();
      formData.append("video", file, file.name);
      logMessage("🎬 Uploading selected video for processing...");
      await sendToBackend(formData);
    };
  </script>
</body>
</html>

  `);
});
//done 
app.post("/process", upload.single("video"), async (req, res) => {
  const videoPath = req.file.path;
  const audioPath = `${videoPath}.wav`;
  const framesDir = path.join("frames", path.basename(videoPath));
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    // === 1️⃣ Extract audio from video ===
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

    // === 2️⃣ Extract frames every 5 s ===
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .on("end", resolve)
        .on("error", reject)
        .output(path.join(framesDir, "frame-%04d.jpg"))
        .outputOptions(["-vf", "fps=1/5"])
        .run();
    });

    // === 3️⃣ OCR frames ===
    let visualText = "";
    for (const f of fs.readdirSync(framesDir)) {
      const framePath = path.join(framesDir, f);
      const { data } = await Tesseract.recognize(framePath, "eng");
      visualText += "\n" + data.text;
    }

    // === 4️⃣ Upload audio to S3 ===
    const s3KeyAudio = `audio/${path.basename(audioPath)}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: s3KeyAudio,
        Body: fs.readFileSync(audioPath),
        ContentType: "audio/wav",
      })
    );
    const s3UriAudio = `s3://${process.env.AWS_S3_BUCKET}/${s3KeyAudio}`;

    // === 5️⃣ Transcribe audio ===
    const jobName = `lectureTranscription-${Date.now()}`;
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: "en-US",
        Media: { MediaFileUri: s3UriAudio },
        OutputBucketName: process.env.AWS_S3_BUCKET,
      })
    );

    let transcript;
    while (true) {
      const { TranscriptionJob } = await transcribe.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
      );
      const status = TranscriptionJob.TranscriptionJobStatus;
      if (status === "COMPLETED") {
        const uri = TranscriptionJob.Transcript.TranscriptFileUri;
        const resp = await axios.get(uri);
        transcript = resp.data.results.transcripts[0].transcript;
        break;
      }
      if (status === "FAILED") throw new Error("Transcription failed");
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log("📝 Transcript length:", transcript.length);

    // === 6️⃣ Build prompt for Bedrock ===
    const systemPrompt = `
You are **SmartClassroom AI**, an assistant that turns recorded lectures into organized, readable study notes.

### Produce:
1. 📖 Comprehensive Lecture Summary  
2. 🧾 Detailed Class Notes  
3. 🎯 Key Topics / Keywords  
4. 📚 References / Mentions  
5. 💡 Important Questions (MCQs, Short, Long)  
6. 🔁 Quick Revision Points  

Follow markdown styling, use emojis, clear headings, and stay true to lecture content.
`;

    const prompt = `
🎥 **Lecture Transcript:**
${transcript}

🖼️ **Extracted Visual Text (Slides / Board Notes):**
${visualText}

Generate the full structured response following the above system instructions.
`;

    // === 7️⃣ Bedrock inference ===
    const modelId = "meta.llama3-70b-instruct-v1:0";
    console.log("🤖 Sending prompt to Bedrock…");

    const invokeCmd = new InvokeModelCommand({
      modelId,
      body: JSON.stringify({
        prompt: `${systemPrompt}\n\n${prompt}`,
        max_gen_len: 3000,
        temperature: 0.7,
        top_p: 0.9,
      }),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await bedrock.send(invokeCmd);
    const bodyString = await response.body.transformToString();
    console.log("🧾 Raw Bedrock response:", bodyString);

    let finalNotes;
    try {
      const parsed = JSON.parse(bodyString);
      finalNotes =
        parsed.generation ||
        parsed.output_text ||
        parsed.output?.text ||
        parsed.outputs?.[0]?.text ||
        "⚠️ No output generated.";
    } catch (err) {
      console.error("❌ Parse error:", err);
      finalNotes = "⚠️ Failed to read model response.";
    }

    console.log("🧠 AI Notes Generated preview:", finalNotes.slice(0, 400));

    // === 8️⃣ Create beautiful PDF ===
    const pdfPath = `${videoPath}.pdf`;
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 60 });
      const stream = fs.createWriteStream(pdfPath);
      stream.on("finish", resolve);
      stream.on("error", reject);
      doc.pipe(stream);

      const primaryColor = "#0047AB";
      const accentColor = "#1565C0";
      const textColor = "#222";
      const dividerGray = "#BBBBBB";

      doc.fontSize(30).fillColor(primaryColor).font("Helvetica-Bold")
        .text("Smart Classroom AI Lecture Notes", { align: "center", underline: true })
        .moveDown(1.2);
      doc.moveTo(60, doc.y).lineTo(540, doc.y).strokeColor(dividerGray).lineWidth(1.5).stroke().moveDown(1.2);

      const htmlContent = md.render(finalNotes);
      const lines = htmlContent.replace(/<\/?[^>]+(>|$)/g, "").split("\n").filter(l => l.trim());

      for (let line of lines) {
        line = line.trim();
        if (line.startsWith("#") || /\*\*.*\*\*/.test(line)) {
          const cleaned = line.replace(/^#+\s*/, "").replace(/\*\*/g, "");
          doc.moveDown(0.8).fontSize(20).fillColor(accentColor).font("Helvetica-Bold")
            .text(cleaned.toUpperCase()).moveDown(0.4);
        } else if (/^[-*•]\s/.test(line)) {
          doc.fontSize(14).fillColor(textColor).font("Helvetica")
            .text("• " + line.replace(/^[-*•]\s*/, ""), { indent: 25, lineGap: 5 });
        } else if (/^\d+\./.test(line)) {
          doc.fontSize(14).fillColor(textColor).font("Helvetica-Oblique")
            .text(line, { indent: 20, lineGap: 5 });
        } else {
          doc.fontSize(13.5).fillColor(textColor).font("Helvetica")
            .text(line, { align: "justify", lineGap: 8 });
        }
      }

      doc.moveDown(2).strokeColor(dividerGray).lineWidth(1)
        .moveTo(60, doc.y).lineTo(540, doc.y).stroke().moveDown(0.8);
      doc.fontSize(11.5).fillColor("#666").font("Helvetica-Oblique")
        .text("Generated by SmartClassroom AI — Learn Smart, Study Better", { align: "center" });
      doc.end();
    });

    // === 9️⃣ Upload PDF to S3 ===
    const s3KeyPdf = `notes/${path.basename(pdfPath)}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: s3KeyPdf,
        Body: fs.readFileSync(pdfPath),
        ContentType: "application/pdf",
      })
    );

    const s3UrlPdf = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3KeyPdf}`;
    console.log("✅ PDF uploaded:", s3UrlPdf);

    res.json({ success: true, pdfUrl: s3UrlPdf });

    await safeCleanup([framesDir, audioPath, videoPath, pdfPath]);
  } catch (err) {
    console.error("❌ Process error:", err);
    await safeCleanup([framesDir, `${videoPath}.wav`, videoPath]);
    res.status(500).json({ error: "Error processing lecture." });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
