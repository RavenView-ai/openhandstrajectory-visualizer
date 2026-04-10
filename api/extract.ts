import type { VercelRequest, VercelResponse } from '@vercel/node';
import pako from 'pako';

function parseTarHeader(data: Uint8Array, offset: number): { name: string; size: number; type: number } | null {
  let isNull = true;
  for (let i = 0; i < 512; i++) {
    if (data[offset + i] !== 0) {
      isNull = false;
      break;
    }
  }
  if (isNull) return null;

  const getString = (start: number, length: number): string => {
    let end = start + length;
    for (let i = start; i < start + length; i++) {
      if (data[i] === 0 || data[i] === 0x20) {
        end = i;
        break;
      }
    }
    return new TextDecoder('utf8').decode(data.slice(start, end));
  };

  const name = getString(offset, 100).trim();
  const sizeStr = getString(offset + 124, 12);
  const size = parseInt(sizeStr, 8);
  const typeChar = getString(offset + 156, 1);
  const type = typeChar === '5' ? 5 : 0;

  return { name, size, type };
}

function extractFromTarStreaming(data: Uint8Array): { jsonlContent: string | null; reportContent: any | null } {
  const blockSize = 512;
  let offset = 0;
  let pendingLongName: string | null = null;
  let jsonlContent: string | null = null;
  let reportContent: any | null = null;

  while (offset + blockSize <= data.length) {
    const header = parseTarHeader(data, offset);
    if (header === null) break;

    offset += blockSize;

    if (header.type === 0 && header.size > 0 && header.name) {
      const paddedSize = Math.ceil(header.size / blockSize) * blockSize;

      // Handle GNU tar long link extension
      if (header.name.endsWith('@LongLink') || header.name === '././@LongLink') {
        pendingLongName = new TextDecoder('utf8').decode(data.slice(offset, offset + header.size)).replace(/\0+$/, '');
      } else {
        const fileName = pendingLongName || header.name;
        pendingLongName = null;
        const lowerName = fileName.toLowerCase();

        // Only extract if it's a file we need
        const isJsonl = lowerName.includes('output.jsonl') || lowerName.endsWith('.jsonl');
        const isReport = lowerName.includes('output.report.json') || (lowerName.includes('report') && lowerName.endsWith('.json'));

        if (isJsonl || isReport) {
          const content = new TextDecoder('utf8').decode(data.slice(offset, offset + header.size));
          
          if (isJsonl) {
            jsonlContent = content;
          }
          if (isReport) {
            try {
              reportContent = JSON.parse(content);
            } catch (e) {
              console.warn('Failed to parse report JSON');
            }
          }
        }
      }

      offset += paddedSize;
    }

    // Early exit if we found both files
    if (jsonlContent && reportContent) {
      console.log('Found both files, exiting early');
      break;
    }
  }

  return { jsonlContent, reportContent };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const lowerUrl = url.toLowerCase();
  if (!lowerUrl.endsWith('.tar.gz') && !lowerUrl.endsWith('.tgz') && !lowerUrl.includes('results.tar.gz')) {
    return res.status(400).json({ error: 'URL must point to a .tar.gz file' });
  }

  try {
    console.log('Fetching archive from:', url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    console.log('Downloading archive, size:', contentLength);

    const arrayBuffer = await response.arrayBuffer();
    const gzippedData = new Uint8Array(arrayBuffer);
    
    console.log('Decompressing gzip...');
    
    let decompressed: Uint8Array;
    try {
      const result = pako.ungzip(gzippedData);
      decompressed = result instanceof Uint8Array ? result : new Uint8Array(result);
    } catch (e) {
      const result = pako.inflate(gzippedData);
      decompressed = result instanceof Uint8Array ? result : new Uint8Array(result);
    }

    console.log('Decompressed, size:', decompressed.length);

    // Extract only the files we need
    const { jsonlContent, reportContent } = extractFromTarStreaming(decompressed);

    console.log('Result - jsonl:', !!jsonlContent, 'report:', !!reportContent);

    return res.status(200).json({
      success: true,
      jsonlContent,
      reportContent,
    });

  } catch (error) {
    console.error('Error extracting archive:', error);
    return res.status(500).json({
      error: `Failed to extract archive: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
}
