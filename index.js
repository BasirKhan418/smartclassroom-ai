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

    .loader-section {
      display: none;
      margin-top: 30px;
      text-align: center;
    }
    .loader-bar {
      width: 70%;
      background: #eee;
      border-radius: 20px;
      margin: 10px auto;
      height: 20px;
      overflow: hidden;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    .loader-fill {
      height: 100%;
      background: linear-gradient(90deg, #42a5f5, #1e88e5);
      width: 0%;
      transition: width 0.4s ease;
      border-radius: 20px;
    }
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
  <video id="preview" autoplay muted></video><br>
  <button id="startBtn">Start Recording</button>
  <button id="stopBtn" disabled>Stop Recording</button>

  <div class="loader-section" id="loaderSection">
    <h2>⏳ Processing Lecture...</h2>
    <div class="loader-bar"><div class="loader-fill" id="loaderFill"></div></div>
    <p id="loaderText">Starting...</p>
  </div>

  <div class="log" id="logBox"></div>

  <button id="pdfLink" onclick="window.open(this.dataset.url, '_blank')">📘 View Generated Notes PDF</button>

  <script>
    let recorder, stream;
    const logBox = document.getElementById("logBox");
    const loaderSection = document.getElementById("loaderSection");
    const loaderText = document.getElementById("loaderText");
    const loaderFill = document.getElementById("loaderFill");
    const pdfLink = document.getElementById("pdfLink");

    function logMessage(msg) {
      logBox.style.display = "block";
      logBox.innerHTML += "• " + msg + "<br>";
    }

    function updateLoader(step, text) {
      loaderSection.style.display = "block";
      loaderText.innerText = text;
      loaderFill.style.width = step + "%";
    }

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
        updateLoader(10, "Uploading lecture and extracting audio...");
        try {
          const response = await fetch("/process", { method: "POST", body: formData });
          updateLoader(60, "Analyzing lecture and generating notes...");
          const data = await response.json();

          if (data.success) {
            updateLoader(100, "✅ PDF Generated Successfully!");
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
      updateLoader(30, "Extracting frames and performing OCR...");
      document.getElementById("stopBtn").disabled = true;
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
        // 1️⃣ Extract audio from video
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

        // 2️⃣ Extract frames every 5 seconds
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .on("end", resolve)
                .on("error", reject)
                .output(path.join(framesDir, "frame-%04d.jpg"))
                .outputOptions(["-vf", "fps=1/5"])
                .run();
        });

        // 3️⃣ OCR the frames
        let visualText = "";
        const files = fs.readdirSync(framesDir);
        for (const file of files) {
            const framePath = path.join(framesDir, file);
            const result = await Tesseract.recognize(framePath, "eng");
            visualText += "\n" + result.data.text;
        }

        // 4️⃣ Upload audio file to S3
        const audioFileStream = fs.readFileSync(audioPath);
        const s3KeyAudio = `audio/${path.basename(audioPath)}`;
        await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: s3KeyAudio,
            Body: audioFileStream,
            ContentType: "audio/wav",
        }));
        const s3UriAudio = `s3://${process.env.AWS_S3_BUCKET}/${s3KeyAudio}`;

        // 5️⃣ Start Transcription job
        const jobName = `lectureTranscription-${Date.now()}`;
        await transcribe.send(new StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: "en-US",
            Media: { MediaFileUri: s3UriAudio },
            OutputBucketName: process.env.AWS_S3_BUCKET,
        }));

        // Wait for job completion
        let transcript;
        while (true) {
            const job = await transcribe.send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }));
            const status = job.TranscriptionJob.TranscriptionJobStatus;
            if (status === "COMPLETED") {
                const transcriptUri = job.TranscriptionJob.Transcript.TranscriptFileUri;
                const resp = await axios.get(transcriptUri);
                transcript = resp.data.results.transcripts[0].transcript;
                break;
            } else if (status === "FAILED") {
                throw new Error("Transcription failed");
            }
            await new Promise(r => setTimeout(r, 5000));
        }

        console.log("📝 Transcript obtained.", transcript);

        const systemPrompt = `
You are **SmartClassroom AI**, a world-class academic assistant built for educators and students.
Your job is to process lectures and generate complete, structured study material.

### Your Output Must Include:
1. 📖 **Comprehensive Lecture Summary**
   - Well-structured and divided by subtopics.
   - Written in a student-friendly tone.
   - Include key takeaways and concepts.

2. 🧾 **Detailed Class Notes**
   - Use markdown formatting.
   - Include definitions, formulas, and examples.

3. 🎯 **Key Topics / Keywords**
   - Provide 5–10 main terms or themes.

4. 📚 **References / Mentions**
   - If any academic or external resources appear, list them.

5. 💡 **Important Questions Section**
   Generate **3–5 of each**:
   - **MCQs:** (4 options each, mark the correct one)
   - **Short Questions:** (1–2 lines answers)
   - **Long Questions:** (3–4 lines sample answers)

6. 🔁 **Quick Revision Points**
   - Provide 5 concise bullet points summarizing the lecture.

### Style Guide:
- Use headings, bullet points, and emojis for readability.
- Keep concise but insightful — aim for study usefulness.
- Avoid overly generic questions; base everything strictly on lecture content.
- Use factual accuracy; do not fabricate information.
- If unsure about content, state "write in context of the lecture what's feel right to you".
`;

        const prompt = `
🎥 **Lecture Transcript:**
${transcript}

🖼️ **Extracted Visual Text (Slides / Board Notes):**
${visualText}

Now generate the full structured response following the system instructions above.
`;
        console.log("prompt :", prompt);
        console.log("🤖 Sending prompt to Bedrock AI...");

        const modelId = "meta.llama3-70b-instruct-v1:0"; // ✅ Meta Llama 3 70B Instruct v1

        const response = await bedrock.send(
            new InvokeModelCommand({
                modelId,
                body: JSON.stringify({
                    prompt: `
${systemPrompt}

User Request:
${prompt}
      `,
                    max_gen_len: 3000,  // Token limit for full structured output
                    temperature: 0.7,
                    top_p: 0.9
                }),
                contentType: "application/json",
                accept: "application/json"
            })
        );

        const bodyString = await response.body.transformToString();
        const parsed = JSON.parse(bodyString);
        console.log("🤖 Bedrock AI response received.",parsed);

        // Different models return different keys; handle safely
        const finalNotes =
            parsed.generation ||
            parsed.output_text ||
            parsed.outputs?.[0]?.text ||
            "No output generated.";

        console.log("🧠 AI Notes Generated:\n", finalNotes);



        // 7️⃣ Create PDF
        // 7️⃣ Create PDF
        // 7️⃣ Create Beautiful PDF
// 7️⃣ Create Beautiful PDF
const pdfPath = `${videoPath}.pdf`;

await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60 });
    const stream = fs.createWriteStream(pdfPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);

    // === COLORS & STYLES ===
    const primaryColor = "#0047AB"; // Deep blue
    const accentColor = "#1565C0";  // Bright blue
    const textColor = "#222222";
    const lightGray = "#DDDDDD";
    const dividerGray = "#BBBBBB";

    // === HEADER ===
    doc
        .fontSize(30)
        .fillColor(primaryColor)
        .font("Helvetica-Bold")
        .text("Smart Classroom AI Lecture Notes", { align: "center", underline: true })
        .moveDown(1.2);

    doc
        .moveTo(60, doc.y)
        .lineTo(540, doc.y)
        .strokeColor(dividerGray)
        .lineWidth(1.5)
        .stroke()
        .moveDown(1.5);

    // === PROCESS MARKDOWN ===
    const htmlContent = md.render(finalNotes);
    const lines = htmlContent
        .replace(/<\/?[^>]+(>|$)/g, "")
        .split("\n")
        .filter((line) => line.trim() !== "");

    const addDivider = () => {
        doc.moveDown(0.6);
        doc
            .moveTo(70, doc.y)
            .lineTo(530, doc.y)
            .strokeColor(lightGray)
            .lineWidth(0.7)
            .stroke()
            .moveDown(0.8);
    };

    for (let line of lines) {
        line = line.trim();

        // === HEADINGS (H1, H2, etc.) ===
        if (line.startsWith("#") || line.match(/\*\*.*\*\*/)) {
            const cleaned = line.replace(/^#+\s*/, "").replace(/\*\*/g, "");
            doc
                .moveDown(0.8)
                .fontSize(20)
                .fillColor(accentColor)
                .font("Helvetica-Bold")
                .text(cleaned.toUpperCase(), { align: "left" })
                .moveDown(0.4);
            addDivider();
        }

        // === BULLET POINTS ===
        else if (line.match(/^[-*•]\s/)) {
            const bullet = "•";
            const text = line.replace(/^[-*•]\s*/, "");
            doc
                .moveDown(0.1)
                .fontSize(14)
                .fillColor("#333333")
                .font("Helvetica")
                .text(`${bullet}  ${text}`, {
                    indent: 25,
                    lineGap: 5,
                    continued: false,
                });
        }

        // === NUMBERED LIST ===
        else if (line.match(/^\d+\./)) {
            doc
                .moveDown(0.1)
                .fontSize(14)
                .fillColor("#333333")
                .font("Helvetica-Oblique")
                .text(line, {
                    indent: 20,
                    lineGap: 5,
                });
        }

        // === NORMAL PARAGRAPH ===
        else {
            // Support emoji + nice readable text layout
            doc
                .moveDown(0.2)
                .fontSize(13.5)
                .fillColor(textColor)
                .font("Helvetica")
                .text(line, {
                    align: "justify",
                    lineGap: 8,
                });
        }
    }

    // === FOOTER ===
    doc
        .moveDown(2)
        .strokeColor(dividerGray)
        .lineWidth(1)
        .moveTo(60, doc.y)
        .lineTo(540, doc.y)
        .stroke()
        .moveDown(0.8);

    doc
        .fontSize(11.5)
        .fillColor("#666666")
        .font("Helvetica-Oblique")
        .text("Generated by SmartClassroom AI — Learn Smart, Study Better ", {
            align: "center",
        });

    doc.end();
});





        // ✅ Wait for PDF to exist
        if (!fs.existsSync(pdfPath)) {
            throw new Error(`PDF generation failed, file not found: ${pdfPath}`);
        }

        // 8️⃣ Upload PDF to S3
        const pdfBuffer = fs.readFileSync(pdfPath);
        const s3KeyPdf = `notes/${path.basename(pdfPath)}`;

        await s3.send(
            new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: s3KeyPdf,
                Body: pdfBuffer,
                ContentType: "application/pdf",
            })
        );

        const s3UrlPdf = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3KeyPdf}`;
        console.log("✅ PDF uploaded:", s3UrlPdf);

        // 9️⃣ Respond to client
        res.json({ success: true, pdfUrl: s3UrlPdf });

        // Cleanup
        await safeCleanup([framesDir, audioPath, videoPath, pdfPath]);

    } catch (err) {
        console.error("❌ Error:", err);
        await safeCleanup([framesDir, `${videoPath}.wav`, videoPath]);
        res.status(500).json({ error: "Error processing lecture." });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
