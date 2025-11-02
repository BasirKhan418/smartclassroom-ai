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

        // Different models return different keys; handle safely
        const finalNotes =
            parsed.generation ||
            parsed.output_text ||
            parsed.outputs?.[0]?.text ||
            "No output generated.";

        console.log("🧠 AI Notes Generated:\n", finalNotes);



        // 7️⃣ Create PDF
        const pdfPath = `${videoPath}.pdf`;
        await new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 40 });
            const stream = fs.createWriteStream(pdfPath);
            stream.on("finish", resolve);
            stream.on("error", reject);

            doc.pipe(stream);

            // Header
            doc
                .fontSize(20)
                .fillColor("#0055FF")
                .text("📘 Smart Classroom Lecture Notes", { align: "center" })
                .moveDown(1.5);

            // Convert Markdown to HTML, then to plain formatted segments
            const htmlContent = md.render(finalNotes);

            // Simple HTML-like parser for headings and lists
            const lines = htmlContent
                .replace(/<\/?[^>]+(>|$)/g, "") // remove HTML tags
                .split("\n")
                .filter((line) => line.trim() !== "");

            for (let line of lines) {
                line = line.trim();

                if (line.startsWith("**")) {
                    // Section headings
                    doc
                        .moveDown(0.5)
                        .fontSize(14)
                        .fillColor("#007ACC")
                        .font("Helvetica-Bold")
                        .text(line.replace(/\*\*/g, ""))
                        .moveDown(0.3);
                } else if (line.startsWith("#")) {
                    // Markdown headings
                    doc
                        .moveDown(0.5)
                        .fontSize(13)
                        .fillColor("#FF5733")
                        .font("Helvetica-Bold")
                        .text(line.replace(/^#+\s*/, ""))
                        .moveDown(0.3);
                } else if (line.match(/^[-*•]\s/)) {
                    // Bullet points
                    doc
                        .fontSize(11)
                        .fillColor("#000000")
                        .font("Helvetica")
                        .text(line, { indent: 20 })
                        .moveDown(0.1);
                } else if (line.match(/^\d+\./)) {
                    // Numbered list
                    doc
                        .fontSize(11)
                        .fillColor("#000000")
                        .font("Helvetica")
                        .text(line, { indent: 15 })
                        .moveDown(0.1);
                } else {
                    // Normal text
                    doc
                        .fontSize(11)
                        .fillColor("#222222")
                        .font("Helvetica")
                        .text(line, { align: "left" })
                        .moveDown(0.1);
                }
            }

            // Footer
            doc
                .moveDown(1)
                .fontSize(10)
                .fillColor("#555555")
                .text("Generated by SmartClassroom AI 🧠", { align: "center" });

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
