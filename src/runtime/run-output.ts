import { createHash, randomUUID } from 'node:crypto';
import type { AgentRun } from './contracts.js';
import { fillablePdfEvidenceRefs, pdfArtifactContent, pdfOutputMetadata, synthesizePdfArtifact } from './fillable-pdf.js';
import { populateRunLimitations } from './run-limitations.js';

/** Preserve completed work without replaying an ambiguous, potentially billed call. */
export async function preserveRunOutput(run: AgentRun, limitation: string): Promise<boolean> {
  const output = run.pdfOutputs?.at(-1);
  if (output && !run.artifacts.some(artifact => artifact.structured?.schemaVersion === 'fillable-pdf/1' && artifact.structured.output.ref === output.ref)) {
    const receipt = run.toolReceipts.find(receipt => receipt.operation === 'pdf.fill' && receipt.status === 'completed'
      && receipt.authorization?.decision === 'authorized' && receipt.outputRefs.includes(output.ref));
    const observed = new Set(run.calls.filter(call => call.phase === 'executor').flatMap(call => {
      const input = call.modelRequest?.input as { availableEvidenceRefs?: string[] } | undefined;
      return input?.availableEvidenceRefs ?? [];
    }));
    observed.add(output.ref);
    const structured = receipt && await synthesizePdfArtifact(output, run.context.sources, observed);
    if (receipt) {
      const content = structured ? pdfArtifactContent(structured)
        : `Unverified PDF draft retained: ${output.filename} [${output.ref}]. Field values and their source support were not validated. Review this draft before use.`;
      const taskId = receipt.authorization!.taskId;
      run.artifacts = run.artifacts.filter(artifact => artifact.taskId !== taskId);
      run.artifacts.push({ id: `artifact_${randomUUID()}`, taskId, title: 'Filled PDF', content,
        ...(structured ? { artifactType: 'fillable-pdf/1' as const, structured, evidenceRefs: fillablePdfEvidenceRefs(structured) }
          : { retainedPdfOutput: { ...pdfOutputMetadata(output), sourceRef: output.sourceRef }, evidenceRefs: [receipt.receiptId, output.ref],
            limitations: ['PDF field evidence could not be validated; retained as an unverified draft.'] }),
        hash: createHash('sha256').update(JSON.stringify({ content, output: pdfOutputMetadata(output) })).digest('hex'), createdAt: new Date().toISOString() });
    }
  }
  // Sources and empty placeholders are not completed work.
  if (!run.artifacts.some(artifact => artifact.content.trim() && (artifact.evidenceRefs.length || !run.context.sources.length))) return false;
  run.status = 'succeeded';
  run.partial = true;
  for (const artifact of run.artifacts) {
    artifact.partial = true;
    artifact.limitations = [...new Set([...(artifact.limitations ?? []), limitation,
      ...(run.review?.verdict === 'needs_revision' ? [`Review requested revision: ${run.review.summary}; ${run.review.issues.join('; ')}`] : [])])];
  }
  delete run.error;
  delete run.resumeStatus;
  populateRunLimitations(run);
  return true;
}
