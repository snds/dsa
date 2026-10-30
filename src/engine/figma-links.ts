/**
 * Parse a link pasted from Figma.
 *   https://www.figma.com/design/AbC123/Name, /file/AbC123, /proto/…, /board/…  -> file
 *   https://www.figma.com/files/project/123/Name, /files/<org>/project/123       -> project
 *   https://www.figma.com/files/team/123/Name,   /files/<org>/team/123          -> team
 * Lives in the core so Settings can check links without the Figma add-on.
 */
export function parseFigmaUrl(url: string): { kind: 'file' | 'project' | 'team'; id: string } | null {
  const u = url.trim();
  let m = u.match(/figma\.com\/(?:design|file|proto|board|slides)\/([A-Za-z0-9]{10,})/);
  if (m) return { kind: 'file', id: m[1]! };
  m = u.match(/figma\.com\/files\/(?:[^/]+\/)?project\/(\d+)/);
  if (m) return { kind: 'project', id: m[1]! };
  m = u.match(/figma\.com\/files\/(?:[^/]+\/)?team\/(\d+)/);
  if (m) return { kind: 'team', id: m[1]! };
  if (/^[A-Za-z0-9]{10,}$/.test(u)) return { kind: 'file', id: u };
  return null;
}
