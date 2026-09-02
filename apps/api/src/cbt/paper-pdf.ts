import { createPdfDocument } from "../common/pdf-document";

/**
 * ONE definition of what a printed question paper looks like.
 *
 * It was private to `CbtService`, which was right while a school's own exam was
 * the only thing printed. A scholarship paper is printed by the PLATFORM OWNER
 * for a physical sitting — a second audience for the same document — and a
 * second copy of this is how two papers start disagreeing about what a question
 * looks like on the page.
 *
 * Pure: it is handed the rows and returns bytes. Who may print, and whose
 * questions they are, is the caller's business.
 */
export function renderPaperPdf(
  d: {
    exam: { title: string; durationMinutes: number; shuffle: boolean };
    bankName: string;
    schoolName: string;
    subjectName: string | null;
    className: string | null;
    ordered: Array<{ prompt: string; choices: string[]; answerIndex: number; type: string; maxMarks: number }>;
  },
  withAnswers: boolean,
  logo: Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = createPdfDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (logo) {
      try {
        doc.image(logo, doc.page.width / 2 - 22, 40, { fit: [44, 44], align: "center" });
        doc.moveDown(3);
      } catch {
        /* an unsupported image must not cost an invigilator their paper */
      }
    }
    doc.fontSize(15).text(d.schoolName || "Question Paper", { align: "center" });
    doc.moveDown(0.2).fontSize(13).text(d.exam.title, { align: "center" });
    doc.moveDown(0.2).fontSize(9);
    const meta = [d.subjectName, d.className, `${d.exam.durationMinutes} minutes`].filter(Boolean).join("  ·  ");
    doc.text(meta, { align: "center" });

    if (withAnswers) {
      // Unmissable on a photocopy: this sheet carries the key.
      doc.moveDown(0.5).fontSize(11).fillColor("#b00").text("ANSWER KEY — NOT FOR CANDIDATES", { align: "center" });
      doc.fillColor("#000");
    }
    if (d.exam.shuffle) {
      // The honest caveat. Online candidates each get their own draw, so this
      // sheet is one variant — printing it as "the paper" would be a lie.
      doc.moveDown(0.4).fontSize(8).fillColor("#666").text(
        "This exam shuffles: each online candidate receives a different selection. " +
          "This sheet is ONE variant, suitable for an offline sitting or moderation.",
        { align: "center" },
      );
      doc.fillColor("#000");
    }

    doc.moveDown(1).fontSize(9).fillColor("#444")
      .text("Answer ALL questions. Shade or write your answer clearly.", { align: "center" });
    doc.fillColor("#000").moveDown(1);

    let n = 0;
    let section = "";
    for (const q of d.ordered) {
      const label = q.type === "THEORY" ? "SECTION B — Theory" : "SECTION A — Objective";
      if (label !== section) {
        section = label;
        doc.moveDown(0.6).fontSize(11).text(label);
        doc.moveDown(0.3);
      }
      n += 1;
      doc.fontSize(10).text(`${n}.  ${q.prompt}`, { paragraphGap: 2 });
      if (q.type === "THEORY") {
        doc.fontSize(8).fillColor("#666").text(`(${q.maxMarks} mark${q.maxMarks === 1 ? "" : "s"})`);
        doc.fillColor("#000");
        // Ruled space to actually write in — a theory paper with no room to
        // answer is not a usable document.
        doc.moveDown(0.4);
        for (let i = 0; i < 4; i++) doc.moveDown(0.9);
      } else {
        q.choices.forEach((c, i) => {
          const letter = String.fromCharCode(65 + i);
          const correct = withAnswers && i === q.answerIndex;
          doc.fontSize(10).fillColor(correct ? "#0a0" : "#000")
            .text(`     ${correct ? "*" : " "}${letter}.  ${c}`);
        });
        doc.fillColor("#000");
      }
      doc.moveDown(0.5);
      if (doc.y > doc.page.height - 90) doc.addPage();
    }

    doc.moveDown(1).fontSize(8).fillColor("#666")
      .text(`${n} question${n === 1 ? "" : "s"} · generated ${new Date().toISOString().slice(0, 10)}`, {
        align: "center",
      });
    doc.end();
  });
}
