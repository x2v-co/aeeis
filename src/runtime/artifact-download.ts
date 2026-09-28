export function artifactFilename(title: string): string {
  const stem = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\.md$/i, '').trim().replace(/[. ]+$/g, '')).slice(0, 60).join('');
  return `${stem || 'aeeis-artifact'}.md`;
}
