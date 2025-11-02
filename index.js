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
        // 5️⃣ Run dual-language transcription (English + Hindi)

        const jobBase = `lectureTranscription-${Date.now()}`;

// --- Helper: Transliterate Hindi → Roman English ---
async function transliterateHindiToRoman(text) {
    try {
        const resp = await axios.get(
            `https://inputtools.google.com/request?text=${encodeURIComponent(text)}&itc=hi-t-i0-und&num=1`
        );
        if (resp.data[0] === "SUCCESS") {
            return resp.data[1].map((i) => i[1][0]).join(" ");
        }
        return text;
    } catch (err) {
        console.warn("⚠️ Transliteration failed:", err.message);
        return text;
    }
}

// --- Helper: Run a transcription job ---
async function transcribeJob(jobName, languageCode) {
    console.log(`🎙️ Starting transcription for ${languageCode}...`);

    await transcribe.send(
        new StartTranscriptionJobCommand({
            TranscriptionJobName: jobName,
            LanguageCode: languageCode,
            Media: { MediaFileUri: s3UriAudio },
            OutputBucketName: process.env.AWS_S3_BUCKET,
        })
    );

    // Wait for job to finish
    while (true) {
        const job = await transcribe.send(
            new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
        );
        const status = job.TranscriptionJob.TranscriptionJobStatus;

        if (status === "COMPLETED") {
            const transcriptUri = job.TranscriptionJob.Transcript.TranscriptFileUri;
            const resp = await axios.get(transcriptUri);
            const text = resp.data.results.transcripts[0].transcript;
            console.log(`✅ ${languageCode} transcription completed.`);
            return text;
        } else if (status === "FAILED") {
            console.warn(`❌ Transcription failed for ${languageCode}`);
            return "";
        }

        await new Promise((r) => setTimeout(r, 5000));
    }
}

// --- Run both transcriptions ---
const transcriptEN = await transcribeJob(`${jobBase}-EN`, "en-US");
let transcriptHI = await transcribeJob(`${jobBase}-HI`, "hi-IN");

// --- Transliterate Hindi output ---
if (transcriptHI) {
    console.log("🔡 Transliteration in progress...");
    transcriptHI = await transliterateHindiToRoman(transcriptHI);
    console.log("✅ Transliteration done:", transcriptHI.slice(0, 200) + "...");
}

// --- Combine both transcripts ---
let mergedTranscript = "";
if (transcriptEN && transcriptHI) {
    mergedTranscript = `
--- 🗣️ English Transcription ---
${transcriptEN}

--- 🇮🇳 Hindi (Romanized) Transcription ---
${transcriptHI}
`;
} else {
    mergedTranscript = transcriptEN || transcriptHI || "No transcript available.";
}

        console.log("✅ Combined transcript ready.");

        console.log("📝 Transcript obtained.", mergedTranscript);

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
- Use headings, bullet points, sub headinfs for clarity.
- Ensure content is original, avoid plagiarism.
- Use simple language, avoid jargon.
- Maintain logical flow and coherence.
note doesnot use emojis in the final output.
- Keep concise but insightful — aim for study usefulness.
- Avoid overly generic questions; base everything strictly on lecture content.
note: add on content by yourself if content is small so add content by yourself to make it more useful for students.
`;

        const prompt = `
🎥 **Lecture Transcript:**
${mergedTranscript}

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
        console.log("🤖 Bedrock AI response received.", parsed);

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
        const pdfPath = `${videoPath}.pdf`;
        await new Promise((resolve, reject) => {
            const doc = new PDFDocument({ margin: 60 });
            const stream = fs.createWriteStream(pdfPath);
            stream.on("finish", resolve);
            stream.on("error", reject);
            doc.pipe(stream);

            // === HEADER ===
            doc
                .fontSize(28)
                .fillColor("#0047AB")
                .font("Helvetica-Bold")
                .text("Smart Classroom AI Lecture Notes", { align: "center" })
                .moveDown(1);

            doc
                .moveTo(50, doc.y)
                .lineTo(550, doc.y)
                .strokeColor("#AAAAAA")
                .lineWidth(1.2)
                .stroke()
                .moveDown(1.2);

            // === Process Markdown ===
            const htmlContent = md.render(finalNotes);
            const lines = htmlContent
                .replace(/<\/?[^>]+(>|$)/g, "")
                .split("\n")
                .filter((line) => line.trim() !== "");

            const addDivider = () => {
                doc.moveDown(0.4);
                doc
                    .moveTo(60, doc.y)
                    .lineTo(540, doc.y)
                    .strokeColor("#DDDDDD")
                    .lineWidth(0.5)
                    .stroke()
                    .moveDown(0.8);
            };

            for (let line of lines) {
                line = line.trim();

                // === HEADINGS ===
                if (line.startsWith("#") || line.match(/\*\*.*\*\*/)) {
                    const cleaned = line.replace(/^#+\s*/, "").replace(/\*\*/g, "");
                    doc
                        .moveDown(1)
                        .fontSize(18)
                        .fillColor("#0D47A1")
                        .font("Helvetica-Bold")
                        .text(cleaned)
                        .moveDown(0.3);
                    addDivider();
                }

                // === BULLET POINTS ===
                else if (line.match(/^[-*•]\s/)) {
                    const bullet = "•";
                    const text = line.replace(/^[-*•]\s*/, "");
                    doc
                        .fontSize(13)
                        .fillColor("#000000")
                        .font("Helvetica")
                        .text(`${bullet} ${text}`, { indent: 20 })
                        .moveDown(0.2);
                }

                // === NUMBERED LIST ===
                else if (line.match(/^\d+\./)) {
                    doc
                        .fontSize(13)
                        .fillColor("#111111")
                        .font("Helvetica")
                        .text(line, { indent: 15 })
                        .moveDown(0.2);
                }

                // === NORMAL PARAGRAPH ===
                else {
                    // Keep emojis visible
                    doc
                        .fontSize(13)
                        .fillColor("#222222")
                        .font("Helvetica")
                        .text(line, { align: "left", lineGap: 6 })
                        .moveDown(0.3);
                }
            }

            // === FOOTER ===
            doc
                .moveDown(2)
                .strokeColor("#AAAAAA")
                .lineWidth(1)
                .moveTo(50, doc.y)
                .lineTo(550, doc.y)
                .stroke()
                .moveDown(0.8);

            doc
                .fontSize(11)
                .fillColor("#555555")
                .font("Helvetica-Oblique")
                .text("Generated by SmartClassroom AI — Learn Smart, Study Better", { align: "center" });

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
