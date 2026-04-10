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

export function extractFromTar(data: Uint8Array): { jsonlContent: string | null; reportContent: any | null } {
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

export async function fetchAndExtractTarGz(url: string): Promise<{ jsonlContent: string | null; reportContent: any | null }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const gzippedData = new Uint8Array(arrayBuffer);
  
  let decompressed: Uint8Array;
  try {
    decompressed = pako.ungzip(gzippedData);
  } catch {
    decompressed = pako.inflate(gzippedData);
  }
  
  return extractFromTar(decompressed);
}