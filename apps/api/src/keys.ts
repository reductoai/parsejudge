/** R2 object keys. */
/** The upload as received, streamed straight to R2 before its format is known. Recorded as `documents.source_key`. */
export const uploadKey = (documentId: string) => `documents/${documentId}/upload`;
/** The upload as received, in its own format. Documents uploaded before `documents.source_key` existed. */
export const sourceKey = (documentId: string, format: string) => `documents/${documentId}/source.${format}`;
/** A DOCX or PPTX upload converted to PDF, and every document before `documents.pdf_key` existed. */
export const documentKey = (documentId: string) => `documents/${documentId}.pdf`;
export const pagePdfKey = (pageId: string) => `pages/${pageId}.pdf`;
export const pagePngKey = (pageId: string) => `pages/${pageId}.png`;
export const markdownKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.md`;
export const rawKey = (runId: string, pageId: string, presetId: string) => `runs/${runId}/${pageId}/${presetId}.json`;
export const pageId = (documentId: string, index: number) => `${documentId}-${index}`;
