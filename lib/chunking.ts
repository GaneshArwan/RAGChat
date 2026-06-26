import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export const chunker = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});

export async function splitDocuments(text: string, metadata: Record<string, any>) {
  const docs = await chunker.createDocuments([text], [metadata]);
  return docs;
}
